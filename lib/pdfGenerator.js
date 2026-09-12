const PDFDocument = require('pdfkit');
const { getSettings } = require('./settings');

function generateInvoicePDF(invoice) {
  return new Promise((resolve, reject) => {
    try {
      const settings = getSettings();
      const shopName = settings.shop_name || 'Mart POS';
      const gstin = settings.gstin || '';

      const doc = new PDFDocument({ margin: 20, size: 'A4' });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(16).font('Helvetica-Bold').text(shopName, { align: 'left' });
      doc.moveDown();

      // GSTIN
      if (gstin) {
        doc.fontSize(10).font('Helvetica').text(`GSTIN: ${gstin}`, { align: 'left' });
        doc.moveDown(0.3);
      }

      // Invoice details
      doc.fontSize(10).font('Helvetica').text(
        `Invoice: ${invoice.invoice_no}    Date: ${invoice.created_at}`,
        { align: 'left' }
      );
      doc.moveDown(0.3);

      // Customer info
      const customerName = invoice.party_name || 'Walk-in';
      doc.fontSize(10).font('Helvetica').text(`Customer: ${customerName}`, { align: 'left' });
      doc.moveDown(0.8);

      // Line separator
      doc.moveTo(20, doc.y)
         .lineTo(doc.page.width - 20, doc.y)
         .stroke();
      doc.moveDown(0.8);

      // Table header
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Item', 20, doc.y, { width: 300 });
      doc.text('Qty', 320, doc.y, { width: 50, align: 'right' });
      doc.text('Price', 370, doc.y, { width: 60, align: 'right' });
      doc.text('GST%', 430, doc.y, { width: 40, align: 'right' });
      doc.text('Total', 470, doc.y, { width: 80, align: 'right' });
      doc.moveDown(0.5);

      // Table content
      doc.fontSize(10).font('Helvetica');
      const items = invoice.items || [];
      
      for (const item of items) {
        // Check if we need a new page
        if (doc.y > 750) {
          doc.addPage();
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text('Item', 20, doc.y, { width: 300 });
          doc.text('Qty', 320, doc.y, { width: 50, align: 'right' });
          doc.text('Price', 370, doc.y, { width: 60, align: 'right' });
          doc.text('GST%', 430, doc.y, { width: 40, align: 'right' });
          doc.text('Total', 470, doc.y, { width: 80, align: 'right' });
          doc.moveDown(0.5);
          doc.fontSize(10).font('Helvetica');
        }

        const itemName = (item.name || '').toString().substring(0, 40);
        const quantity = parseFloat(item.quantity) || 0;
        const price = parseFloat(item.price) || 0;
        const gstPercent = parseFloat(item.gst_percent) || 0;
        const lineTotal = parseFloat(item.line_total) || 0;

        doc.text(itemName, 20, doc.y, { width: 300 });
        doc.text(quantity.toFixed(2), 320, doc.y, { width: 50, align: 'right' });
        doc.text(price.toFixed(2), 370, doc.y, { width: 60, align: 'right' });
        doc.text(gstPercent.toFixed(0), 430, doc.y, { width: 40, align: 'right' });
        doc.text(lineTotal.toFixed(2), 470, doc.y, { width: 80, align: 'right' });
        doc.moveDown(0.4);
      }

      doc.moveDown(0.4);
      // Line separator
      doc.moveTo(20, doc.y)
         .lineTo(doc.page.width - 20, doc.y)
         .stroke();
      doc.moveDown(0.8);

      // Totals
      doc.fontSize(10).font('Helvetica');
      const subtotal = parseFloat(invoice.subtotal) || 0;
      const discount = parseFloat(invoice.discount) || 0;
      const cgst = parseFloat(invoice.cgst) || 0;
      const sgst = parseFloat(invoice.sgst) || 0;
      const igst = parseFloat(invoice.igst) || 0;
      const total = parseFloat(invoice.total) || 0;
      const paid = parseFloat(invoice.paid) || 0;
      const paymentMethod = invoice.payment_method || 'Cash';

      const totalsX = 370;
      doc.text('Subtotal:', totalsX, doc.y, { width: 100, align: 'right' });
      doc.text(subtotal.toFixed(2), totalsX + 100, doc.y, { width: 80, align: 'right' });
      doc.moveDown(0.4);

      doc.text('Discount:', totalsX, doc.y, { width: 100, align: 'right' });
      doc.text(discount.toFixed(2), totalsX + 100, doc.y, { width: 80, align: 'right' });
      doc.moveDown(0.4);

      if (igst > 0) {
        doc.text('IGST:', totalsX, doc.y, { width: 100, align: 'right' });
        doc.text(igst.toFixed(2), totalsX + 100, doc.y, { width: 80, align: 'right' });
        doc.moveDown(0.4);
      } else {
        doc.text('CGST:', totalsX, doc.y, { width: 100, align: 'right' });
        doc.text(cgst.toFixed(2), totalsX + 100, doc.y, { width: 80, align: 'right' });
        doc.moveDown(0.4);

        doc.text('SGST:', totalsX, doc.y, { width: 100, align: 'right' });
        doc.text(sgst.toFixed(2), totalsX + 100, doc.y, { width: 80, align: 'right' });
        doc.moveDown(0.4);
      }

      doc.fontSize(12).font('Helvetica-Bold');
      doc.text('Total:', totalsX, doc.y, { width: 100, align: 'right' });
      doc.text(total.toFixed(2), totalsX + 100, doc.y, { width: 80, align: 'right' });
      doc.moveDown(0.8);

      // Payment info
      doc.fontSize(10).font('Helvetica');
      doc.text(`Payment: ${paymentMethod}  Paid: ${paid.toFixed(2)}`, { align: 'left' });
      doc.moveDown(1);

      // Footer
      doc.fontSize(9).font('Helvetica').text('Thank you for shopping with us!', { align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  generateInvoicePDF
};
