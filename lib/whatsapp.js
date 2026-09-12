const twilio = require('twilio');

function formatBillText(invoice) {
  const settings = require('./settings').getSettings();
  const shopName = settings.shop_name || 'Mart POS';
  
  let lines = [
    shopName,
    `Invoice: ${invoice.invoice_no}`,
    `Date: ${invoice.created_at}`,
    '',
    'Items:'
  ];
  
  const items = invoice.items || [];
  for (const item of items) {
    const line = `- ${item.name} x ${item.quantity} @ ${parseFloat(item.price).toFixed(2)} = ${parseFloat(item.line_total).toFixed(2)}`;
    lines.push(line);
  }
  
  lines.push(
    '',
    `Subtotal: ${parseFloat(invoice.subtotal).toFixed(2)}`,
    `Discount: ${parseFloat(invoice.discount || 0).toFixed(2)}`,
    `GST: ${parseFloat(invoice.tax).toFixed(2)}`,
    `Total: ${parseFloat(invoice.total).toFixed(2)}`,
    `Paid (${invoice.payment_method}): ${parseFloat(invoice.paid).toFixed(2)}`,
    '',
    'Thank you for shopping with us!'
  );
  
  return lines.join('\n');
}

async function sendWhatsAppMessage(phone, message, mediaUrl = null) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromWhatsApp = process.env.TWILIO_WHATSAPP_FROM;
  
  // Check if Twilio credentials are configured
  if (!accountSid || !authToken || !fromWhatsApp) {
    console.log(`WhatsApp send simulated. To ${phone}: ${message}`);
    return { 
      ok: true, 
      provider: 'simulated', 
      note: 'Twilio credentials not configured' 
    };
  }
  
  try {
    const client = twilio(accountSid, authToken);
    
    const messageOptions = {
      from: fromWhatsApp,
      to: `whatsapp:${phone}`,
      body: message
    };
    
    if (mediaUrl) {
      messageOptions.mediaUrl = [mediaUrl];
    }
    
    const twilioMessage = await client.messages.create(messageOptions);
    
    return { 
      ok: true, 
      provider: 'twilio',
      messageSid: twilioMessage.sid 
    };
  } catch (error) {
    console.error('Twilio WhatsApp error:', error);
    return { 
      ok: false, 
      error: error.message, 
      provider: 'twilio' 
    };
  }
}

module.exports = {
  formatBillText,
  sendWhatsAppMessage
};
