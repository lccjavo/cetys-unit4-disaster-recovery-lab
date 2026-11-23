'use strict';

/**
 * Customer profile data classification.
 *
 * - 20 SENSITIVE fields: encrypted with AES-256-GCM using each customer's DEK.
 *   Stored in customer_sensitive_data.encrypted_fields (JSONB).
 * - 20 lower-sensitivity OPERATIONAL fields (for this educational scenario):
 *   regular columns in the customers table, protected by authentication/authorization
 *   but WITHOUT application-level encryption.
 */

const SENSITIVE_FIELDS = [
  { key: 'phone_number', label: 'Personal phone number', group: 'contact', staff: true },
  { key: 'personal_email', label: 'Personal email', group: 'contact', staff: true },
  { key: 'home_address', label: 'Home address', group: 'contact' },
  { key: 'billing_address', label: 'Billing address', group: 'contact' },
  { key: 'date_of_birth', label: 'Date of birth', group: 'identity' },
  { key: 'tax_id_rfc', label: 'Mexican tax ID, RFC (fictional)', group: 'identity' },
  { key: 'passport_number', label: 'Passport (fictional)', group: 'identity' },
  { key: 'card_number', label: 'Test payment card (not valid)', group: 'financial' },
  { key: 'cardholder_name', label: 'Cardholder name', group: 'financial' },
  { key: 'card_expiration', label: 'Card expiration (MM/YYYY)', group: 'financial' },
  { key: 'bank_account_number', label: 'Bank account (fictional)', group: 'financial' },
  { key: 'clabe', label: 'CLABE (fictional, bank 999)', group: 'financial' },
  { key: 'annual_income_range', label: 'Annual income range', group: 'financial' },
  { key: 'outstanding_balance', label: 'Outstanding balance', group: 'financial' },
  { key: 'employer_name', label: 'Employer', group: 'employment' },
  { key: 'company_legal_name', label: 'Company legal name', group: 'employment' },
  { key: 'room_guests', label: 'Other guests sharing the room', group: 'family', staff: true },
  { key: 'accompanying_children', label: 'Accompanying children', group: 'family', staff: true },
  { key: 'emergency_contact_name', label: 'Emergency contact', group: 'emergency', staff: true },
  { key: 'emergency_contact_phone', label: 'Emergency contact phone', group: 'emergency', staff: true },
];

const OPERATIONAL_FIELDS = [
  { key: 'display_nickname', label: 'Display nickname', type: 'text' },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'preferred_language', label: 'Preferred language', type: 'select', options: ['Spanish', 'English', 'French', 'German', 'Portuguese', 'Japanese'] },
  { key: 'time_zone', label: 'Time zone', type: 'text' },
  { key: 'preferred_currency', label: 'Preferred currency', type: 'select', options: ['MXN', 'USD', 'CAD', 'EUR', 'COP', 'ARS', 'CLP', 'PEN', 'BRL', 'JPY'] },
  { key: 'preferred_room_category', label: 'Preferred room category', type: 'select', options: ['Single', 'Double', 'Junior Suite', 'Executive Suite', 'Family'] },
  { key: 'preferred_bed_type', label: 'Preferred bed type', type: 'select', options: ['Single', 'Full', 'Queen', 'King', 'Two beds'] },
  { key: 'preferred_floor', label: 'Preferred floor', type: 'select', options: ['Low', 'Middle', 'High', 'No preference'] },
  { key: 'preferred_room_view', label: 'Preferred room view', type: 'select', options: ['Ocean', 'City', 'Garden', 'Mountain', 'No preference'] },
  { key: 'preferred_pillow_type', label: 'Preferred pillow type', type: 'select', options: ['Feather', 'Memory foam', 'Hypoallergenic', 'Firm', 'Soft'] },
  { key: 'preferred_checkin_time', label: 'Preferred check-in time', type: 'time' },
  { key: 'preferred_checkout_time', label: 'Preferred check-out time', type: 'time' },
  { key: 'breakfast_preference', label: 'Breakfast preference', type: 'select', options: ['Continental', 'American', 'Mexican', 'Vegetarian', 'Vegan', 'No breakfast'] },
  { key: 'parking_required', label: 'Parking required', type: 'bool' },
  { key: 'wifi_usage_preference', label: 'Wi-Fi usage', type: 'select', options: ['Basic', 'Remote work', 'Streaming', 'Not used'] },
  { key: 'newsletter_opt_in', label: 'Newsletter subscription', type: 'bool' },
  { key: 'loyalty_tier', label: 'Loyalty tier', type: 'select', options: ['Bronze', 'Silver', 'Gold', 'Platinum'] },
  { key: 'preferred_contact_channel', label: 'Preferred contact channel', type: 'select', options: ['Email', 'SMS', 'WhatsApp', 'Phone call', 'Hotel app'] },
  { key: 'favorite_amenity', label: 'Favorite amenity', type: 'select', options: ['Pool', 'Spa', 'Gym', 'Restaurant', 'Bar', 'Business center', 'Kids club'] },
];

const SENSITIVE_KEYS = SENSITIVE_FIELDS.map((f) => f.key);
const OPERATIONAL_KEYS = OPERATIONAL_FIELDS.map((f) => f.key);
const STAFF_REVEALABLE = SENSITIVE_FIELDS.filter((f) => f.staff).map((f) => f.key);

const GROUPS = {
  contact: 'Contact',
  identity: 'Identity',
  financial: 'Financial',
  employment: 'Employment',
  family: 'Accompanying guests',
  emergency: 'Emergency',
};

// Profile tabs and the groups each one shows.
const PROFILE_TABS = {
  personal: ['contact', 'identity', 'emergency'],
  financial: ['financial', 'employment'],
  family: ['family'],
};

const CUSTOMER_STATUSES = ['active', 'vip', 'inactive', 'suspended'];
const STATUS_LABELS = { active: 'Active', vip: 'VIP', inactive: 'Inactive', suspended: 'Suspended' };
const RESERVATION_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'];
const RESERVATION_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  checked_out: 'Checked out',
  cancelled: 'Cancelled',
};
const ROOM_TYPES = ['Single', 'Double', 'Junior Suite', 'Executive Suite', 'Family'];
const ROOM_RATES = { Single: 1450, Double: 1890, 'Junior Suite': 2900, 'Executive Suite': 4200, Family: 3300 };

if (SENSITIVE_FIELDS.length !== 20 || OPERATIONAL_FIELDS.length !== 20) {
  throw new Error('The classification must have exactly 20 sensitive and 20 operational fields');
}

module.exports = {
  SENSITIVE_FIELDS,
  OPERATIONAL_FIELDS,
  SENSITIVE_KEYS,
  OPERATIONAL_KEYS,
  STAFF_REVEALABLE,
  GROUPS,
  PROFILE_TABS,
  CUSTOMER_STATUSES,
  STATUS_LABELS,
  RESERVATION_STATUSES,
  RESERVATION_LABELS,
  ROOM_TYPES,
  ROOM_RATES,
};
