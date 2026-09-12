const QRCode = require('qrcode');
const { getSettings } = require('./settings');

function buildUPIDeeplink(amount, note = 'Mart POS Bill') {
  const settings = getSettings();
  const params = {
    pa: settings.upi_vpa || 'merchant@upi',
    pn: settings.upi_name || settings.shop_name || 'Mart POS',
    am: amount.toFixed(2),
    tn: note,
    cu: 'INR'
  };

  // Build UPI deeplink
  const paramString = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  
  return `upi://pay?${paramString}`;
}

async function generateUPIQRCode(amount, note = 'Mart POS Bill') {
  try {
    const deeplink = buildUPIDeeplink(amount, note);
    const qrCodeDataURL = await QRCode.toDataURL(deeplink);
    
    // Convert data URL to buffer
    const base64Data = qrCodeDataURL.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    
    return buffer;
  } catch (error) {
    throw new Error(`Failed to generate UPI QR code: ${error.message}`);
  }
}

module.exports = {
  buildUPIDeeplink,
  generateUPIQRCode
};
