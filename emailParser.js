function parseCarrierEmail(emailContent) {
    const content = (emailContent || '').toLowerCase();

  // Detect carrier
  let carrier = 'Unknown';
    if (content.includes('fedex')) carrier = 'FedEx';
    else if (content.includes('ups')) carrier = 'UPS';
    else if (content.includes('usps')) carrier = 'USPS';

  // Extract tracking number
  let tracking_number = extractTrackingNumber(content, carrier);

  // Extract estimated delivery date
  let estimated_delivery = extractDeliveryDate(content, carrier);

  // Extract merchant/sender
  let merchant = extractMerchant(content, carrier);

  // Determine status
  let status = detectStatus(content);

  return {
        carrier,
        tracking_number,
        estimated_delivery,
        merchant,
        status,
  };
}

function extractTrackingNumber(content, carrier) {
    let match;

  if (carrier === 'FedEx') {
        // FedEx: Look for long numbers, often after "shipment" or at start of subject
      match = content.match(/shipment[:\s]+(\d{12,})/i);
        if (!match) match = content.match(/\b(\d{12,15})\b/);
  } else if (carrier === 'UPS') {
        // UPS: Tracking number is typically 1Z followed by alphanumerics
      match = content.match(/\b(1z[a-z0-9]{16})\b/i);
        if (!match) match = content.match(/tracking.*?(\d{1,}[a-z0-9]{10,})/i);
  } else if (carrier === 'USPS') {
        // USPS: Long numeric tracking numbers
      match = content.match(/tracking number[:\s]+(\d{20,})/i);
        if (!match) match = content.match(/\b(\d{20,})\b/);
  }

  return match ? match[1] : null;
}

function extractDeliveryDate(content, carrier) {
    let match;
    const months = [
          'january', 'february', 'march', 'april', 'may', 'june',
          'july', 'august', 'september', 'october', 'november', 'december'
        ];

  if (carrier === 'FedEx') {
        // FedEx patterns:
      // "Scheduled delivery date: Wed 4/08/2026"
      // "Scheduled delivery date: Tue, 04/07/2026"
      match = content.match(/scheduled delivery date[:\s]+([a-z]+,?\s+\d{1,2}\/\d{2}\/\d{4})/i);
        if (match) return formatDate(match[1]);

      // Fallback: any date pattern
      match = content.match(/(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(\d{1,2})\/(\d{2})\/(\d{4})/i);
        if (match) return `${match[1]} ${match[2]}/${match[3]}/${match[4]}`;
  } else if (carrier === 'UPS') {
        // UPS patterns:
      // "Estimated Delivery: Tuesday 03/31/2026"
      match = content.match(/estimated delivery[:\s]+([a-z]+\s+\d{1,2}\/\d{2}\/\d{4})/i);
        if (match) return formatDate(match[1]);

      // Fallback
      match = content.match(/(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(\d{1,2})\/(\d{2})\/(\d{4})/i);
        if (match) return `${match[1]} ${match[2]}/${match[3]}/${match[4]}`;
  } else if (carrier === 'USPS') {
        // USPS patterns:
      // "Expected Delivery on Wednesday, April 1, 2026 arriving by 9:00pm"
      // "Estimated Delivery on: Friday, Apr 03"
      match = content.match(/expected delivery on\s+([a-z]+,\s+[a-z]+\s+\d{1,2},\s+\d{4})/i);
        if (match) return formatDate(match[1]);

      match = content.match(/estimated delivery on[:\s]+([a-z]+,\s+[a-z]+\s+\d{2})/i);
        if (match) return formatDate(match[1]);

      // Fallback: look for day + month + day + year pattern
      match = content.match(/(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
        if (match) return `${match[2]} ${match[3]}, ${match[4]}`;

      // Another USPS pattern: just month and day
      match = content.match(/expected\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})/i);
        if (match) return `${match[2]} ${match[1]}, ${match[3]}`;
  }

  return null;
}

function extractMerchant(content, carrier) {
    let match;

  if (carrier === 'FedEx') {
        // "Your shipment from Chewy is on the way"
      match = content.match(/shipment from\s+([a-z0-9\s]+)\s+is/i);
        if (match) return match[1].trim();
  } else if (carrier === 'UPS') {
        // "Your package is arriving today. From AMAZON.COM"
      match = content.match(/from\s+([a-z0-9\s\.]+?)(?:\n|$)/i);
        if (match) return match[1].trim();
  } else if (carrier === 'USPS') {
        // "Package Shipped from: HDP"
      match = content.match(/shipped from[:\s]+([a-z0-9\s\.]+?)(?:\n|tracking|$)/i);
        if (match) return match[1].trim();
  }

  return 'Unknown Sender';
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

  // Try to parse "Wednesday, April 1, 2026" format
  let match = lower.match(/([a-z]+),?\s+([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (match) {
          const monthNum = months[match[2]] || '01';
          const day = String(match[3]).padStart(2, '0');
          const year = match[4];
          return `${match[2].charAt(0).toUpperCase() + match[2].slice(1)} ${day}, ${year}`;
    }

  // Try to parse "Wed 4/08/2026" format
  match = lower.match(/([a-z]+),?\s+(\d{1,2})\/(\d{2})\/(\d{4})/);
    if (match) {
          const monthNum = match[2].padStart(2, '0');
          const day = match[3];
          const year = match[4];
          return `April ${day}, ${year}`;
    }

  return dateStr.trim();
}

module.exports = { parseCarrierEmail };
