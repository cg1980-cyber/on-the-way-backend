// emailParser.js
// Parses forwarded shipping-confirmation emails into structured package data.
//
// Returns an object that always includes an `isShipping` flag. Consumers
// (server.js) should check that flag before persisting a row — otherwise
// the database fills up with junk rows generated from non-shipping email.
//
// Fields use snake_case so they can be spread directly into the Supabase
// `packages` row without case translation.

function parseCarrierEmail(emailContent) {
  const raw = emailContent || '';
  const content = raw.toLowerCase();

  // 1. Carrier detection — use word boundaries and carrier-specific phrases
  //    to avoid matching "ups" inside "groups", "setups", "support", etc.
  const carrier = detectCarrier(content);

  // 2. Tracking number — try carrier-specific patterns, then a generic fallback
  const tracking_number = extractTrackingNumber(content, carrier);

  // 3. Estimated delivery date
  const estimated_delivery = extractDeliveryDate(content, carrier);

  // 4. Merchant — guarded so we don't capture "from gmail" or "from my iphone"
  //    out of random forwarded headers.
  const merchant = extractMerchant(content, carrier);

  // 5. Status
  const status = detectStatus(content);

  // 6. Shipping signal — only treat this as a real shipment if we have
  //    BOTH a recognized carrier AND at least one shipping keyword,
  //    OR a tracking-number-shaped string in the body.
  const hasShippingKeyword = SHIPPING_KEYWORDS.some(k => content.includes(k));
  const isShipping =
    (carrier !== 'Unknown' && hasShippingKeyword) ||
    !!tracking_number;

  return {
    carrier,
    tracking_number,
    estimated_delivery,
    merchant,
    status,
    isShipping,
  };
}

const SHIPPING_KEYWORDS = [
  'tracking number',
  'tracking #',
  'tracking:',
  'shipped',
  'shipment',
  'on the way',
  'out for delivery',
  'estimated delivery',
  'expected delivery',
  'scheduled delivery',
  'arriving',
  'package',
  'order has shipped',
];

function detectCarrier(content) {
  // FedEx — distinctive token, word boundary to be safe.
  if (/\bfedex\b/.test(content) || content.includes('fedex.com')) return 'FedEx';

  // UPS — require word boundary OR a UPS-specific phrase / tracking shape,
  // because "ups" is a substring of many innocent words ("groups",
  // "setups", "support"...).
  if (
    /\bups\b/.test(content) ||
    content.includes('ups.com') ||
    content.includes('ups my choice') ||
    /\b1z[a-z0-9]{16}\b/i.test(content) // UPS tracking-number shape
  ) {
    return 'UPS';
  }

  // USPS — same precaution.
  if (
    /\busps\b/.test(content) ||
    content.includes('usps.com') ||
    content.includes('united states postal service') ||
    content.includes('postal service')
  ) {
    return 'USPS';
  }

  return 'Unknown';
}

function extractTrackingNumber(content, carrier) {
  let match;

  if (carrier === 'FedEx') {
    match = content.match(/shipment[:\s]+(\d{12,})/i);
    if (!match) match = content.match(/\b(\d{12,15})\b/);
  } else if (carrier === 'UPS') {
    match = content.match(/\b(1z[a-z0-9]{16})\b/i);
    if (!match) match = content.match(/tracking.*?(\d{1,}[a-z0-9]{10,})/i);
  } else if (carrier === 'USPS') {
    match = content.match(/tracking number[:\s]+(\d{20,})/i);
    if (!match) match = content.match(/\b(\d{20,})\b/);
  } else {
    // Generic fallback: look for any tracking-number-shaped string
    // labelled as such.
    match = content.match(/tracking number[:\s]+([a-z0-9]{10,})/i);
    if (!match) match = content.match(/\b(1z[a-z0-9]{16})\b/i);
    if (!match) match = content.match(/\b(\d{20,})\b/);
  }

  return match ? match[1] : null;
}

function extractDeliveryDate(content, carrier) {
  let match;

  if (carrier === 'FedEx') {
    match = content.match(/scheduled delivery date[:\s]+([a-z]+,?\s+\d{1,2}\/\d{2}\/\d{4})/i);
    if (match) return formatDate(match[1]);

    match = content.match(/(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(\d{1,2})\/(\d{2})\/(\d{4})/i);
    if (match) return `${match[1]} ${match[2]}/${match[3]}/${match[4]}`;
  } else if (carrier === 'UPS') {
    match = content.match(/estimated delivery[:\s]+([a-z]+\s+\d{1,2}\/\d{2}\/\d{4})/i);
    if (match) return formatDate(match[1]);

    match = content.match(/(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(\d{1,2})\/(\d{2})\/(\d{4})/i);
    if (match) return `${match[1]} ${match[2]}/${match[3]}/${match[4]}`;
  } else if (carrier === 'USPS') {
    match = content.match(/expected delivery on\s+([a-z]+,\s+[a-z]+\s+\d{1,2},\s+\d{4})/i);
    if (match) return formatDate(match[1]);

    match = content.match(/estimated delivery on[:\s]+([a-z]+,\s+[a-z]+\s+\d{2})/i);
    if (match) return formatDate(match[1]);

    match = content.match(/(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (match) return `${match[2]} ${match[3]}, ${match[4]}`;

    match = content.match(/expected\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})/i);
    if (match) return `${match[2]} ${match[1]}, ${match[3]}`;
  }

  return null;
}

// Generic / forwarded-mail provider words we should NEVER treat as a merchant.
// Most show up because the parser sees lines like "Sent from my iPhone" or
// "Forwarded from gmail" in the body of forwarded shipping emails.
const MERCHANT_BLOCKLIST = new Set([
  'gmail', 'yahoo', 'outlook', 'hotmail', 'aol', 'icloud',
  'google', 'apple', 'microsoft',
  'my iphone', 'my ipad', 'my android', 'my phone',
  'mail', 'email', 'noreply', 'no-reply', 'no reply',
  'unknown sender', 'unknown',
]);

function extractMerchant(content, carrier) {
  let candidate = null;
  let match;

  if (carrier === 'FedEx') {
    match = content.match(/shipment from\s+([a-z0-9\s]+?)\s+is/i);
    if (match) candidate = match[1].trim();
  } else if (carrier === 'UPS') {
    // Prefer "from <merchant>" near a "shipped" or "package" cue rather
    // than any "from" anywhere.
    match = content.match(/(?:package|shipment|order)\s+from\s+([a-z0-9\s\.]+?)(?:\n|\r|\.|,|$)/i);
    if (match) candidate = match[1].trim();
  } else if (carrier === 'USPS') {
    match = content.match(/shipped from[:\s]+([a-z0-9\s\.]+?)(?:\n|\r|tracking|$)/i);
    if (match) candidate = match[1].trim();
  }

  // Cross-carrier fallback: "your order from <merchant>"
  if (!candidate) {
    match = content.match(/your (?:order|shipment|package) from\s+([a-z0-9\s\.]+?)(?:\n|\r|\.|,|is|has|$)/i);
    if (match) candidate = match[1].trim();
  }

  if (!candidate) return null;

  // Strip junk and reject if it lands in the blocklist.
  const cleaned = candidate.replace(/\s+/g, ' ').trim();
  if (!cleaned || MERCHANT_BLOCKLIST.has(cleaned.toLowerCase())) {
    return null;
  }

  return cleaned;
}

function detectStatus(content) {
  if (content.includes('delivered')) return 'Delivered';
  if (content.includes('out for delivery')) return 'Out for Delivery';
  if (content.includes('on the way') || content.includes('in transit')) return 'In Transit';
  if (content.includes('label created') || content.includes('label has been created')) return 'Label Created';
  if (content.includes('delayed') || content.includes('delay')) return 'Delayed';
  if (content.includes('available for pickup')) return 'Available for Pickup';
  if (content.includes('scheduled for delivery tomorrow')) return 'Out for Delivery';

  return 'In Transit';
}

function formatDate(dateStr) {
  if (!dateStr) return null;

  const lower = dateStr.toLowerCase();
  const months = {
    'jan': '01', 'january': '01',
    'feb': '02', 'february': '02',
    'mar': '03', 'march': '03',
    'apr': '04', 'april': '04',
    'may': '05',
    'jun': '06', 'june': '06',
    'jul': '07', 'july': '07',
    'aug': '08', 'august': '08',
    'sep': '09', 'september': '09',
    'oct': '10', 'october': '10',
    'nov': '11', 'november': '11',
    'dec': '12', 'december': '12'
  };

  // "Wednesday, April 1, 2026"
  let match = lower.match(/([a-z]+),?\s+([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (match) {
    const monthName = match[2];
    const day = String(match[3]).padStart(2, '0');
    const year = match[4];
    return `${monthName.charAt(0).toUpperCase() + monthName.slice(1)} ${day}, ${year}`;
  }

  // "Wed 4/08/2026"
  match = lower.match(/([a-z]+),?\s+(\d{1,2})\/(\d{2})\/(\d{4})/);
  if (match) {
    const monthNum = match[2].padStart(2, '0');
    const day = match[3];
    const year = match[4];
    const monthName =
      Object.keys(months).find(k => months[k] === monthNum && k.length > 3) ||
      'Month';
    return `${monthName.charAt(0).toUpperCase() + monthName.slice(1)} ${day}, ${year}`;
  }

  return dateStr.trim();
}

module.exports = { parseCarrierEmail };
