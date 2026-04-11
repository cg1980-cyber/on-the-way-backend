// emailParser.js
// Parses carrier notification emails to extract package tracking info

/**
 * Detect which carrier sent this email based on sender address and subject
 */
function detectCarrier(from, subject) {
  const fromLower = (from || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();

  if (fromLower.includes('usps.com') || subjectLower.includes('usps') || subjectLower.includes('informed delivery')) {
    return 'USPS';
  }
  if (fromLower.includes('ups.com') || subjectLower.includes('ups ') || subjectLower.includes('united parcel')) {
    return 'UPS';
  }
  if (fromLower.includes('fedex.com') || subjectLower.includes('fedex')) {
    return 'FedEx';
  }
  if (fromLower.includes('dhl.com') || subjectLower.includes('dhl')) {
    return 'DHL';
  }
  if (fromLower.includes('amazon.com') || subjectLower.includes('amazon')) {
    return 'Amazon';
  }

  return 'Unknown';
}

/**
 * Extract tracking number from email text using carrier-specific patterns
 */
function extractTrackingNumber(text, carrier) {
  if (!text) return null;

  const patterns = {
    USPS: [
      /\b(9[2345][0-9]{18,20})\b/,        // USPS 20-22 digit
      /\b(94[0-9]{18})\b/,                 // Priority Mail
      /\b(EC[0-9]{9}US)\b/i,              // Express Mail
      /\b(CP[0-9]{9}US)\b/i,              // First Class Package
    ],
    UPS: [
      /\b(1Z[A-Z0-9]{16})\b/i,            // Standard UPS format
    ],
    FedEx: [
      /\b([0-9]{12,15})\b/,               // FedEx 12-15 digit
      /\b([0-9]{20,22})\b/,               // FedEx Door Tag
    ],
    DHL: [
      /\b([0-9]{10,11})\b/,               // DHL standard
      /\b(JD[0-9]{18})\b/i,              // DHL Express
    ],
    Amazon: [
      /\b(TBA[0-9]{12})\b/i,             // Amazon Logistics
      /\b(1Z[A-Z0-9]{16})\b/i,           // Amazon via UPS
    ],
  };

  const carrierPatterns = patterns[carrier] || [];
  for (const pattern of carrierPatterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase();
  }

  return null;
}

/**
 * Extract the delivery status from email subject/body
 */
function extractStatus(subject, text) {
  const combined = ((subject || '') + ' ' + (text || '')).toLowerCase();

  if (combined.includes('delivered')) return 'Delivered';
  if (combined.includes('out for delivery') || combined.includes('on its way')) return 'Out for Delivery';
  if (combined.includes('arrived at') || combined.includes('at a facility') || combined.includes('in transit')) return 'In Transit';
  if (combined.includes('picked up') || combined.includes('accepted') || combined.includes('shipping label created')) return 'Label Created';
  if (combined.includes('delay') || combined.includes('exception')) return 'Delayed';
  if (combined.includes('available for pickup') || combined.includes('held at')) return 'Available for Pickup';

  return 'In Transit';
}

/**
 * Extract estimated delivery date from email text
 */
function extractDeliveryDate(text, subject) {
  const combined = (text || '') + ' ' + (subject || '');

  // Look for patterns like "by Monday, April 14" or "April 14, 2026" or "04/14/2026"
  const datePatterns = [
    /by\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(\w+ \d{1,2})/i,
    /estimated delivery[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{0,4})/i,
    /deliver(?:ed|y)[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{0,4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{2,4})/,
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{0,4}/i,
  ];

  for (const pattern of datePatterns) {
    const match = combined.match(pattern);
    if (match) {
      // Return the last capture group which has the date
      return match[match.length - 1].trim();
    }
  }

  return null;
}

/**
 * Extract merchant/shipper name from email
 * This is what shows as the "from" name in the app
 */
function extractMerchant(from, subject, text) {
  // Try to get display name from the "from" field (e.g., "Amazon Orders <ship-confirm@amazon.com>")
  const displayNameMatch = from.match(/^"?([^"<]+)"?\s*</);
  if (displayNameMatch) {
    let name = displayNameMatch[1].trim();
    // Clean up generic names
    if (!['noreply', 'no-reply', 'notifications', 'tracking', 'alerts'].some(g => name.toLowerCase().includes(g))) {
      return name;
    }
  }

  // Try to find merchant name in subject
  const subjectPatterns = [
    /your (.+?) (?:order|shipment|package)/i,
    /from (.+?) (?:has|is)/i,
  ];
  for (const pattern of subjectPatterns) {
    const match = subject.match(pattern);
    if (match && match[1].length < 30) return match[1].trim();
  }

  // Fall back to domain name from email
  const domainMatch = from.match(/@([a-zA-Z0-9-]+)\./);
  if (domainMatch) {
    return domainMatch[1].charAt(0).toUpperCase() + domainMatch[1].slice(1);
  }

  return 'Unknown Shipper';
}

/**
 * Main function: parse an inbound email and return structured package data
 */
function parseCarrierEmail({ from, subject, text, html }) {
  const plainText = text || '';

  const carrier = detectCarrier(from, subject);
  const trackingNumber = extractTrackingNumber(plainText, carrier);
  const status = extractStatus(subject, plainText);
  const estimatedDelivery = extractDeliveryDate(plainText, subject);
  const merchant = extractMerchant(from, subject, plainText);

  return {
    carrier,
    trackingNumber,
    status,
    estimatedDelivery,
    merchant,
    rawSubject: subject,
    parsedAt: new Date().toISOString(),
  };
}

module.exports = { parseCarrierEmail };
