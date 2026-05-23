import { Document, Page, Text, View, StyleSheet, pdf } from "@react-pdf/renderer";
import type { Invoice, InvoiceLine, Client, Settings } from "@prisma/client";
import { formatNumberES } from "./money";

type InvoiceForPdf = Invoice & { lines: InvoiceLine[]; client: Client };

const COLOR_BLUE = "#173867";
const COLOR_HEADER_BG = "#1f3a6b";
const COLOR_BORDER = "#dadfe6";
const COLOR_MUTED = "#737a85";

const styles = StyleSheet.create({
  page: {
    fontSize: 9,
    fontFamily: "Helvetica",
    color: "#111",
    paddingTop: 56,
    paddingHorizontal: 56,
    paddingBottom: 110,
  },
  bigTitle: { fontSize: 36, color: COLOR_BLUE, fontFamily: "Helvetica-Bold", marginBottom: 14 },
  rowMeta: { flexDirection: "row", marginBottom: 4 },
  metaLabelBold: { width: 70, fontFamily: "Helvetica-Bold", fontSize: 11 },
  metaValueBold: { fontFamily: "Helvetica-Bold", fontSize: 11 },
  metaLabel: { width: 70, color: COLOR_MUTED },
  metaValue: {},
  parties: { flexDirection: "row", marginTop: 28, gap: 32 },
  partyCol: { flex: 1 },
  partyHeader: {
    color: COLOR_BLUE,
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    paddingBottom: 4,
    marginBottom: 6,
    borderBottom: `1px solid ${COLOR_BORDER}`,
  },
  partyName: { fontFamily: "Helvetica-Bold", fontSize: 11, marginBottom: 4 },
  partyLine: { marginBottom: 2 },
  emailLine: { marginTop: 4, color: COLOR_MUTED },
  // Line items table
  tableWrap: { marginTop: 24 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: COLOR_HEADER_BG,
    color: "white",
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottom: `1px solid ${COLOR_BORDER}`,
  },
  colDesc: { flex: 5 },
  colQty: { flex: 1.5, textAlign: "right" },
  colUnit: { flex: 1.5, textAlign: "right" },
  colVat: { flex: 1.2, textAlign: "right" },
  colNet: { flex: 1.5, textAlign: "right" },
  // Totals
  bottom: { marginTop: 18, flexDirection: "row", gap: 18 },
  footnote: { flex: 1.2, fontFamily: "Helvetica-Bold", fontSize: 9, lineHeight: 1.4 },
  totals: { flex: 1 },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 6,
    backgroundColor: "#f4f5f8",
  },
  totalsRowAlt: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 6,
  },
  totalRowFinal: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 8,
    backgroundColor: COLOR_HEADER_BG,
    color: "white",
    marginTop: 1,
  },
  totalFinalLabel: { fontFamily: "Helvetica-Bold", fontSize: 11 },
  totalFinalValue: { fontFamily: "Helvetica-Bold", fontSize: 11 },
  // Footer
  thanks: {
    position: "absolute",
    bottom: 110,
    left: 56,
    right: 56,
    textAlign: "center",
    color: "#cdd1d8",
    fontSize: 22,
  },
  pageFooter: {
    position: "absolute",
    bottom: 36,
    left: 56,
    right: 56,
    borderTop: `1px solid ${COLOR_BORDER}`,
    paddingTop: 10,
    flexDirection: "row",
    gap: 24,
    fontSize: 8.5,
  },
  footerCol: { flex: 1 },
  footerHeading: { fontFamily: "Helvetica-Bold", marginBottom: 4 },
  pleaseAdd: {
    marginTop: 14,
    textAlign: "right",
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
  },
});

function eurFmt(c: number): string {
  return formatNumberES(c / 100, 2);
}

export function InvoiceDocument({
  invoice,
  settings,
}: {
  invoice: InvoiceForPdf;
  settings: Settings;
}) {
  const lines = [...invoice.lines].sort((a, b) => a.position - b.position);
  const totalVatPct = lines[0]?.vatRate ?? 0;
  const vatRateLabel = (totalVatPct * 100).toFixed(0);
  const exemptMark = invoice.vatExempt ? " ¹" : "";

  return (
    <Document title={`Invoice ${invoice.number}`}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.bigTitle}>INVOICE</Text>

        <View style={styles.rowMeta}>
          <Text style={styles.metaLabelBold}>Invoice No:</Text>
          <Text style={styles.metaValueBold}>{invoice.number}</Text>
        </View>
        <View style={styles.rowMeta}>
          <Text style={styles.metaLabel}>Date:</Text>
          <Text style={styles.metaValue}>{invoice.date.toISOString().slice(0, 10)}</Text>
        </View>
        <View style={styles.rowMeta}>
          <Text style={styles.metaLabel}>Due Date:</Text>
          <Text style={styles.metaValue}>{invoice.dueDate.toISOString().slice(0, 10)}</Text>
        </View>

        <View style={styles.parties}>
          <View style={styles.partyCol}>
            <Text style={styles.partyHeader}>Sent to:</Text>
            <Text style={styles.partyName}>{invoice.client.name}</Text>
            {invoice.client.vatId ? (
              <Text style={styles.partyLine}>VAT ID: {invoice.client.vatId}</Text>
            ) : null}
            {invoice.client.taxId ? (
              <Text style={styles.partyLine}>Reg. no: {invoice.client.taxId}</Text>
            ) : null}
            <Text style={styles.partyLine}>{invoice.client.addressLine}</Text>
            <Text style={styles.partyLine}>
              {invoice.client.postalCode} {invoice.client.city}
            </Text>
            <Text style={styles.partyLine}>{invoice.client.country}</Text>
            {invoice.client.email ? (
              <Text style={styles.emailLine}>({invoice.client.email})</Text>
            ) : null}
          </View>
          <View style={styles.partyCol}>
            <Text style={styles.partyHeader}>Sent by:</Text>
            <Text style={styles.partyName}>{settings.issuerName}</Text>
            <Text style={styles.partyLine}>VAT ID: {settings.issuerVatId}</Text>
            <Text style={styles.partyLine}>Reg. no: {settings.issuerTaxId}</Text>
            <Text style={styles.partyLine}>{settings.issuerAddressLine}</Text>
            <Text style={styles.partyLine}>
              {settings.issuerPostalCode} {settings.issuerCity}
            </Text>
            <Text style={styles.partyLine}>{settings.issuerProvince}</Text>
            <Text style={styles.partyLine}>{settings.issuerCountry}</Text>
          </View>
        </View>

        <View style={styles.tableWrap}>
          <View style={styles.tableHeader}>
            <Text style={styles.colDesc}>Description</Text>
            <Text style={styles.colQty}>Quantity</Text>
            <Text style={styles.colUnit}>Unit price</Text>
            <Text style={styles.colVat}>VAT rate</Text>
            <Text style={styles.colNet}>Net amount</Text>
          </View>
          {lines.map((l, idx) => (
            <View key={l.id} style={styles.tableRow}>
              <Text style={styles.colDesc}>
                {idx + 1}. {l.description}
              </Text>
              <Text style={styles.colQty}>
                {formatNumberES(l.quantity, 0)} {l.unit}
              </Text>
              <Text style={styles.colUnit}>{eurFmt(l.unitPriceCents)}</Text>
              <Text style={styles.colVat}>
                {(l.vatRate * 100).toFixed(0)}%{invoice.vatExempt ? " ¹" : ""}
              </Text>
              <Text style={styles.colNet}>{eurFmt(l.netCents)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.bottom}>
          <View style={styles.footnote}>
            {invoice.vatExempt && invoice.exemptionNote ? (
              <Text>¹ {invoice.exemptionNote}</Text>
            ) : null}
          </View>
          <View style={styles.totals}>
            <View style={styles.totalsRow}>
              <Text>Subtotal without taxes:</Text>
              <Text>{eurFmt(invoice.subtotalCents)} EUR</Text>
            </View>
            <View style={styles.totalsRowAlt}>
              <Text>
                VAT {vatRateLabel}%{exemptMark}:
              </Text>
              <Text>{eurFmt(invoice.vatCents)} EUR</Text>
            </View>
            <View style={styles.totalRowFinal}>
              <Text style={styles.totalFinalLabel}>Invoice total:</Text>
              <Text style={styles.totalFinalValue}>{eurFmt(invoice.totalCents)} EUR</Text>
            </View>
          </View>
        </View>

        <Text style={styles.pleaseAdd}>Please add the invoice number to your payment description.</Text>

        <Text style={styles.thanks}>Thank you for your business!</Text>

        <View style={styles.pageFooter} fixed>
          <View style={styles.footerCol}>
            <Text style={styles.footerHeading}>Company contacts:</Text>
            <Text>{settings.issuerName}</Text>
            <Text>Reg. no: {settings.issuerTaxId}</Text>
            <Text>VAT ID: {settings.issuerVatId}</Text>
          </View>
          <View style={styles.footerCol}>
            <Text>{settings.issuerAddressLine}</Text>
            <Text>
              {settings.issuerPostalCode} {settings.issuerCity}
            </Text>
            <Text>{settings.issuerProvince}</Text>
            <Text>{settings.issuerCountry}</Text>
          </View>
          <View style={styles.footerCol}>
            <Text style={styles.footerHeading}>Bank account:</Text>
            <Text>Bank name: {settings.bankName}</Text>
            <Text>IBAN: {settings.bankIban}</Text>
            <Text>SWIFT: {settings.bankSwift}</Text>
            {settings.bankAddress ? <Text>{settings.bankAddress}</Text> : null}
          </View>
        </View>
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(args: {
  invoice: InvoiceForPdf;
  settings: Settings;
}): Promise<Buffer> {
  const stream = await pdf(<InvoiceDocument {...args} />).toBuffer();
  // pdf().toBuffer() returns a NodeJS.ReadableStream; collect to Buffer.
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
