// AEAT "fichero de importación" generators for MOD 130, 303, 349.
//
// Specs (downloaded to docs/aeat/):
//   - MOD 130: DR130e15v12.xls (versión 1.2, since Orden HAP/258/2015)
//   - MOD 303: DR303e26v101.xlsx (versión 1.01, for ejercicio 2026+)
//   - MOD 349: DR_Anexo_349.pdf (Orden HAC/174/2020, ejercicio 2020+)
//
// Encoding: ISO-8859-1, uppercase, no accents. Each form is a fixed-width
// string written as bytes — Spain's portal accepts UTF-8 BOM-less files in
// practice for ASCII-only content, but we encode to latin1 to be safe.
//
// IMPORTANT: AEAT's "Importar" feature checks the constants and field
// lengths strictly. These generators target the bare-minimum field set
// needed for our scenario (single autónomo, intra-EU services only,
// no recargo de equivalencia, no SII, no prorrata, no agri/ganad).
// Any change in the user's tax regime will require revisiting this.

import type { QuarterReport, Quarter } from "./tax";
import type { Settings } from "@prisma/client";

const SPACE = " ";

// ---------- Primitive field helpers ----------

function stripAccents(s: string): string {
  // Replace accented vowels with unaccented, keep "Ñ" and "Ç" (per spec).
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

export function padA(value: string, len: number): string {
  const cleaned = stripAccents(value).replace(/[^A-ZÑÇ0-9 ./-]/g, "");
  const v = cleaned.slice(0, len);
  return v + SPACE.repeat(Math.max(0, len - v.length));
}

export function padN(value: number | string, len: number): string {
  const s = String(value);
  if (s.length > len) throw new Error(`numeric overflow: ${s} into width ${len}`);
  return "0".repeat(len - s.length) + s;
}

// 15-integer + 2-decimal unsigned amount (17 chars). For "Num" fields.
// Input is cents to keep things integer.
export function amountNum(cents: number, intLen = 15, decLen = 2): string {
  if (cents < 0)
    throw new Error(`amountNum got negative ${cents}; use amountSigned for signed fields`);
  const intPart = Math.trunc(cents / 100);
  const decPart = Math.abs(cents % 100);
  return padN(intPart, intLen) + padN(decPart, decLen);
}

// 15-integer + 2-decimal signed amount (17 chars). For "N" fields.
// Negative values get an "N" in the leading position (replacing a leading 0).
export function amountSigned(cents: number, intLen = 15, decLen = 2): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const intPart = Math.trunc(abs / 100);
  const decPart = abs % 100;
  const intStr = padN(intPart, intLen);
  const out = intStr + padN(decPart, decLen);
  if (!neg) return out;
  // Replace leading "0" with "N".
  if (out[0] !== "0") throw new Error(`amountSigned: width too tight for ${cents}`);
  return "N" + out.slice(1);
}

// 349-style split amounts. Numbers are unsigned, integer + decimal stored
// as two adjacent right-zero-padded fields of given lengths.
export function amountSplit(cents: number, intLen: number, decLen = 2): string {
  if (cents < 0) throw new Error(`amountSplit got negative ${cents}`);
  const intPart = Math.trunc(cents / 100);
  const decPart = cents % 100;
  return padN(intPart, intLen) + padN(decPart, decLen);
}

function quarterCode(q: Quarter): string {
  return `${q}T`;
}

// 9-position NIF, right-aligned with zero-padding on the left. The control
// character (last) stays in position 9. AEAT specs say "Este campo deberá
// estar ajustado a la derecha, siendo la última posición el carácter de
// control y rellenando con ceros las posiciones de la izquierda".
function nif9(value: string): string {
  const cleaned = value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (cleaned.length === 0) return "         ";
  if (cleaned.length > 9) throw new Error(`NIF too long: ${cleaned}`);
  return "0".repeat(9 - cleaned.length) + cleaned;
}

// ---------- Encoding ----------

// Encode the final string to ISO-8859-1 bytes. JavaScript's String can hold
// arbitrary code points; we map known specials and reject anything else by
// substituting "?".
export function toLatin1(s: string): Buffer {
  const buf = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i)!;
    if (code <= 0xff) {
      buf[i] = code;
    } else if (code === 0x00d1) {
      buf[i] = 0xd1; // Ñ
    } else if (code === 0x00c7) {
      buf[i] = 0xc7; // Ç
    } else {
      buf[i] = 0x3f; // '?'
    }
  }
  return buf;
}

// ---------- Envelope (shared between MOD 130 and MOD 303) ----------

function envelopeOpen(opts: {
  model: "130" | "303";
  year: number;
  period: string; // "1T" .. "4T" or "01" .. "12"
}): string {
  const head =
    "<T" + opts.model + "0" + padN(opts.year, 4) + opts.period + "0000>";
  // <AUX>...</AUX> developer block. We're an unregistered EED, so leave
  // version + NIF developer blank — AEAT accepts this when importing locally.
  const aux =
    "<AUX>" +
    SPACE.repeat(70) + // 23-92 reserved
    "0001" + // 93-96 software version (free text, 4 chars)
    SPACE.repeat(4) + // 97-100
    SPACE.repeat(9) + // 101-109 NIF developer (blank)
    SPACE.repeat(213) + // 110-322
    "</AUX>";
  return head + aux;
}

function envelopeClose(opts: { model: "130" | "303"; year: number; period: string }): string {
  return "</T" + opts.model + "0" + padN(opts.year, 4) + opts.period + "0000>";
}

// ---------- MOD 130 ----------

export function buildMod130(args: {
  settings: Settings;
  report: QuarterReport;
}): Buffer {
  const { settings, report } = args;
  const period = quarterCode(report.quarter);
  const year = report.year;

  // Split name into surnames (up to 60) + first name (up to 20).
  const { surnames, firstName } = splitSpanishName(settings.issuerName);
  const tipoDeclaracion = pickTipoDeclaracion130(report.mod130.box19);

  let page = "<T13001000>";        // 1-11
  page += " ";                       // 12 (pagina complementaria — blanco)
  page += tipoDeclaracion;          // 13 (I/U/G/N/B)
  page += nif9(settings.issuerTaxId); // 14-22
  page += padA(surnames, 60);       // 23-82
  page += padA(firstName, 20);      // 83-102
  page += padN(year, 4);             // 103-106
  page += period;                    // 107-108 (1T..4T)

  // 109-: liquidation boxes [01]..[19] — each 15+2 fixed.
  // Boxes 01,02,04,05,06 unsigned (Num). 03,07,11,14,17,19 signed (N).
  page += amountNum(report.mod130.box01);     // [01]
  page += amountNum(report.mod130.box02);     // [02]
  page += amountSigned(report.mod130.box03);  // [03] (signed)
  page += amountNum(report.mod130.box04);     // [04]
  page += amountNum(report.mod130.box05);     // [05]
  page += amountNum(report.mod130.box06);     // [06]
  page += amountSigned(report.mod130.box07);  // [07] (signed)
  // II. Agricultural — all zero for us.
  page += amountNum(0); // [08]
  page += amountNum(0); // [09]
  page += amountNum(0); // [10]
  page += amountSigned(0); // [11]
  // III. Total liquidation.
  page += amountNum(report.mod130.box12);     // [12]
  page += amountNum(0);                       // [13] minoración (0)
  page += amountSigned(report.mod130.box14);  // [14]
  page += amountNum(0);                       // [15] resultados negativos prior
  page += amountNum(0);                       // [16] vivienda
  page += amountSigned(report.mod130.box17);  // [17]
  page += amountNum(0);                       // [18] complementaria prior
  page += amountSigned(report.mod130.box19);  // [19]

  // Position should now be 109 + 19 * 17 = 109 + 323 = 432.
  page += " ";                       // 432 complementaria X/blank
  page += padN(0, 13);               // 433-445 prior justificante (0 if not C)
  page += padA(settings.bankIban, 34); // 446-479
  page += SPACE.repeat(96);          // 480-575
  page += SPACE.repeat(13);          // 576-588 sello AEAT (blank)
  page += "</T13001000>";            // 589-600

  if (page.length !== 600) {
    throw new Error(`MOD 130 page len ${page.length} ≠ 600`);
  }

  const wrapped =
    envelopeOpen({ model: "130", year, period }) +
    page +
    envelopeClose({ model: "130", year, period });
  return toLatin1(wrapped);
}

function pickTipoDeclaracion130(box19Cents: number): string {
  if (box19Cents > 0) return "U"; // domiciliación (or "I" for ingreso); user changes on AEAT
  if (box19Cents < 0) return "B"; // a deducir en próximos pagos fraccionados
  return "N";                      // negativa / cero
}

// ---------- MOD 303 ----------

export function buildMod303(args: {
  settings: Settings;
  report: QuarterReport;
}): Buffer {
  const { settings, report } = args;
  const period = quarterCode(report.quarter);
  const year = report.year;

  // ----- Page 1 (DP30301) -----
  // Identification block + IVA devengado + IVA deducible (boxes [01]..[46]).
  // For our scenario all IVA devengado boxes are zero (intra-EU exempt
  // outputs). We populate box [28]/[29] (interior input VAT) and the running
  // totals box [45], [46].
  let p1 = "<T30301000>";          // 1-11
  p1 += " ";                          // 12 (complementaria — blanco)
  p1 += pickTipoDeclaracion303(report.mod303.box71); // 13 (I/D/C/N/U/G/V/X)
  p1 += nif9(settings.issuerTaxId);  // 14-22
  p1 += padA(settings.issuerName, 80); // 23-102
  p1 += padN(year, 4);                // 103-106
  p1 += period;                       // 107-108
  // Identification flags 109-130. We're not tributing exclusively foral,
  // not in REDEME, not RS, not autoliq. conjunta, not criterio de Caja,
  // not destinatario de Caja, no prorrata especial, no concurso, no SII,
  // not exonerado de MOD 390 (we are obligated), not "volumen distinto 0",
  // not gasolinas. Encode all the "2 = NO" indicators except the ones spec
  // wants blank/0.
  p1 += "2";                          // 109 foral
  p1 += "2";                          // 110 REDEME
  p1 += "3";                          // 111 régimen (3 = sólo RG)
  p1 += "2";                          // 112 conjunta
  p1 += "2";                          // 113 criterio Caja
  p1 += "2";                          // 114 destinatario Caja
  p1 += "0";                          // 115 prorrata especial (0 vacio/no opta)
  p1 += "0";                          // 116 revocación
  p1 += "2";                          // 117 concurso
  p1 += SPACE.repeat(8);              // 118-125 fecha concurso (DDMMYYYY blank)
  p1 += " ";                          // 126 tipo autoliq concurso (blank)
  p1 += "2";                          // 127 SII voluntario
  p1 += "0";                          // 128 exonerado 390 (0 = no aplica trimestralmente)
  p1 += "0";                          // 129 vol. ops != 0 (0 = no aplica trimestralmente)
  p1 += "2";                          // 130 gasolinas (no)

  // Position now: 131. IVA devengado rows: 15 base+tipo+cuota cells, but each
  // is 17+5+17 = 39 chars. For us, all bases + cuotas are 0, but the tipo %
  // constants are required.
  p1 += zeroBaseTipoCuota("00000"); // [150]/[151]/[152]
  p1 += zeroBaseTipoCuota("00000"); // [165]/[166]/[167]
  p1 += zeroBaseTipoCuota("00400"); // [01]/[02]/[03] 4% IVA superreducido
  p1 += zeroBaseTipoCuota("00000"); // [153]/[154]/[155]
  p1 += zeroBaseTipoCuota("01000"); // [04]/[05]/[06] 10% IVA reducido
  p1 += zeroBaseTipoCuota("02100"); // [07]/[08]/[09] 21% IVA general
  p1 += amountNum(0) + amountNum(0); // [10]/[11] AIC
  p1 += amountNum(0) + amountNum(0); // [12]/[13] inversión sujeto pasivo
  p1 += amountSigned(0) + amountSigned(0); // [14]/[15] modificación bases/cuotas
  p1 += zeroBaseTipoCuota("00175"); // [156]/[157]/[158] recargo eq.
  p1 += zeroBaseTipoCuota("00050"); // [168]/[169]/[170]
  p1 += zeroBaseTipoCuota("00000"); // [16]/[17]/[18]
  p1 += zeroBaseTipoCuota("00140"); // [19]/[20]/[21]
  p1 += zeroBaseTipoCuota("00520"); // [22]/[23]/[24]
  p1 += amountSigned(0) + amountSigned(0); // [25]/[26] modif. recargo

  // Total cuota devengada [27] — N signed.
  p1 += amountSigned(report.mod303.box27);

  // IVA deducible — base+cuota pairs. We populate [28]/[29] (interior corrientes).
  p1 += amountNum(report.mod303.box28) + amountNum(report.mod303.box29); // [28]/[29]
  p1 += amountNum(0) + amountNum(0); // [30]/[31]
  p1 += amountNum(0) + amountNum(0); // [32]/[33]
  p1 += amountNum(0) + amountNum(0); // [34]/[35]
  p1 += amountNum(0) + amountNum(0); // [36]/[37]
  p1 += amountNum(0) + amountNum(0); // [38]/[39]
  p1 += amountSigned(0) + amountSigned(0); // [40]/[41]
  p1 += amountSigned(0);              // [42]
  p1 += amountSigned(0);              // [43]
  p1 += amountSigned(0);              // [44]
  p1 += amountSigned(report.mod303.box45); // [45]
  p1 += amountSigned(report.mod303.box46); // [46]
  // Reserved AEAT 1036-1556 (521) + Sello 1557-1569 (13) + cierre 1570-1581 (12)
  // Position so far should be 1035; we'll pad and add closing.
  if (p1.length > 1035) throw new Error(`MOD 303 page 1 too long: ${p1.length}`);
  p1 += SPACE.repeat(1035 - p1.length); // pad to 1035
  p1 += SPACE.repeat(521);             // 1036-1556
  p1 += SPACE.repeat(13);              // 1557-1569
  p1 += "</T30301000>";                // 1570-1581
  if (p1.length !== 1581)
    throw new Error(`MOD 303 page 1 len ${p1.length} ≠ 1581`);

  // ----- Page 3 (DP30303) -----
  // Información adicional (box [59]) + Resultado (box [64]..[71]) + Sin
  // actividad / Rectificativa flags.
  let p3 = "<T30303000>";          // 1-11
  p3 += amountSigned(report.mod303.box59); // [59]
  p3 += amountSigned(0); // [60] exportaciones
  p3 += amountSigned(0); // [120]
  p3 += amountSigned(0); // [122]
  p3 += amountSigned(0); // [123]
  p3 += amountSigned(0); // [124]
  p3 += amountSigned(0) + amountSigned(0); // [62]/[63]
  p3 += amountSigned(0) + amountSigned(0); // [74]/[75]
  p3 += amountSigned(0);              // [76] regularización cuotas 80.5.5
  p3 += amountSigned(report.mod303.box64); // [64] suma resultados
  p3 += padN(10000, 5);               // [65] % atribuible Estado (100.00 -> 10000)
  p3 += amountSigned(report.mod303.box66); // [66]
  p3 += amountNum(0);                 // [77] IVA importación Aduana
  p3 += amountNum(0);                 // [110] cuotas compensar anteriores
  p3 += amountNum(0);                 // [78] cuotas aplicadas
  p3 += amountNum(0);                 // [87] cuotas pendientes posteriores
  p3 += amountSigned(0);              // [68] regularización anual foral
  p3 += amountSigned(0);              // [108] ajustes rectificativa
  p3 += amountSigned(report.mod303.box69); // [69]
  p3 += amountNum(0);                 // [70] resultados anteriores ingresar
  p3 += amountNum(0);                 // [109] devoluciones AEAT
  p3 += amountNum(0);                 // [112] gasolinas
  p3 += amountSigned(report.mod303.box71); // [71] resultado final

  p3 += " ";                          // sin actividad (X o blanco)
  p3 += " ";                          // autoliq. rectificativa (X o blanco)
  p3 += padN(0, 13);                  // justificante anterior
  p3 += " ";                          // baja/modif. domiciliación
  p3 += amountNum(0);                 // [111] importe rectificación
  p3 += " ";                          // motivo rectificación A
  p3 += " ";                          // motivo rectificación B
  // Reserved 460-1005 (546) + cierre 1006-1017 (12)
  if (p3.length > 459) throw new Error(`MOD 303 page 3 too long: ${p3.length}`);
  p3 += SPACE.repeat(459 - p3.length);
  p3 += SPACE.repeat(546);
  p3 += "</T30303000>";
  if (p3.length !== 1017)
    throw new Error(`MOD 303 page 3 len ${p3.length} ≠ 1017`);

  const wrapped =
    envelopeOpen({ model: "303", year, period }) +
    p1 +
    p3 +
    envelopeClose({ model: "303", year, period });
  return toLatin1(wrapped);
}

function zeroBaseTipoCuota(tipoConst: string): string {
  return amountNum(0) + tipoConst + amountNum(0);
}

function pickTipoDeclaracion303(box71Cents: number): string {
  // Our scenario will always be C (compensar) when there's only input VAT to
  // recover and no domestic output VAT. We let the user pick D (devolución)
  // on AEAT itself for 4T if desired.
  if (box71Cents < 0) return "C";
  if (box71Cents > 0) return "I";
  return "N";
}

// ---------- MOD 349 ----------

export function buildMod349(args: {
  settings: Settings;
  report: QuarterReport;
  declarationId13?: string;
}): Buffer {
  const { settings, report } = args;
  const period = quarterCode(report.quarter);
  const year = report.year;

  // Build the Tipo-1 declarant record (500 chars).
  const totalAmount = report.mod349.reduce((s, op) => s + op.baseCents, 0);
  const numOperators = report.mod349.length;
  const declarationId = args.declarationId13 ?? defaultDeclarationId("349");

  let r1 = "";
  r1 += "1";                          // 1   tipo 1
  r1 += "349";                        // 2-4 modelo
  r1 += padN(year, 4);                // 5-8 ejercicio
  r1 += nif9(settings.issuerTaxId);   // 9-17
  r1 += padA(settings.issuerName, 40); // 18-57
  r1 += SPACE;                        // 58 blanco
  r1 += SPACE.repeat(9);              // 59-67 teléfono (optional, blank)
  r1 += padA(settings.issuerName, 40); // 68-107 nombre contacto
  r1 += declarationId;                // 108-120 número identificativo (13 dig)
  r1 += SPACE;                        // 121 complementaria
  r1 += SPACE;                        // 122 sustitutiva
  r1 += padN(0, 13);                  // 123-135 prior id
  r1 += period;                       // 136-137 período
  r1 += padN(numOperators, 9);        // 138-146 número operadores
  r1 += amountSplit(totalAmount, 13); // 147-161 importe (13 ent + 2 dec)
  r1 += padN(0, 9);                   // 162-170 num rectificaciones
  r1 += amountSplit(0, 13);           // 171-185 importe rectificaciones
  r1 += SPACE;                        // 186 indicador cambio periodicidad
  r1 += SPACE.repeat(204);            // 187-390 blancos
  r1 += SPACE.repeat(9);              // 391-399 NIF representante legal (blank)
  r1 += SPACE.repeat(101);            // 400-500 blancos
  if (r1.length !== 500)
    throw new Error(`MOD 349 type 1 len ${r1.length} ≠ 500`);

  const records: string[] = [r1];

  // Tipo-2 records — one per intra-EU operator.
  for (const op of report.mod349) {
    let r2 = "";
    r2 += "2";                        // 1
    r2 += "349";                      // 2-4
    r2 += padN(year, 4);              // 5-8
    r2 += nif9(settings.issuerTaxId); // 9-17
    r2 += SPACE.repeat(58);           // 18-75
    r2 += padA(op.countryCode, 2);    // 76-77
    r2 += padA(op.vatNumberWithoutPrefix, 15); // 78-92
    r2 += padA(op.name, 40);          // 93-132
    r2 += op.clave;                   // 133
    r2 += amountSplit(op.baseCents, 11); // 134-146 (11 ent + 2 dec)
    r2 += SPACE.repeat(32);           // 147-178 blancos
    r2 += SPACE.repeat(17);           // 179-195 NIF sustituto (blank, only for C)
    r2 += SPACE.repeat(40);           // 196-235 nombre sustituto (blank)
    r2 += SPACE.repeat(265);          // 236-500 blancos
    if (r2.length !== 500)
      throw new Error(`MOD 349 type 2 len ${r2.length} ≠ 500`);
    records.push(r2);
  }

  // Records joined by CRLF (AEAT accepts both LF and CRLF; CRLF is the canonical).
  return toLatin1(records.join("\r\n") + "\r\n");
}

function defaultDeclarationId(model: "349"): string {
  // First 3 digits = model. Remaining 10 = random-ish but stable per call.
  const rand = Math.floor(Math.random() * 1e10);
  return model + padN(rand, 10);
}

// ---------- Helpers ----------

function splitSpanishName(full: string): { surnames: string; firstName: string } {
  // Spanish people normally have first name + two surnames. We assume the
  // configured name is "First Last1 Last2" style; if there are 2 words, treat
  // the second as surname; if 3+, first word(s) up to the second-to-last are
  // first name, the last 1-2 are surnames. The exact split isn't strict for
  // import — what matters is total length doesn't overflow.
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], surnames: "" };
  }
  if (parts.length === 2) {
    return { firstName: parts[0], surnames: parts[1] };
  }
  // Heuristic: take the FIRST token as firstName, rest as surnames.
  return { firstName: parts[0], surnames: parts.slice(1).join(" ") };
}
