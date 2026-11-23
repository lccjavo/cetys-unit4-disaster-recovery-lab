'use strict';

/**
 * 100% FICTIONAL data generator.
 *
 * - Phone numbers use the 555 segment (MX) or 555-01xx (NANP range reserved for fiction).
 * - Emails use the reserved .test domain (RFC 2606).
 * - Cards: public industry TEST numbers; they cannot be used for payments. No CVV.
 * - RFC with a homoclave ending in "LB" (lab); it does not belong to real people.
 * - CLABE with bank code 999 (non-existent) and a computed check digit.
 * - Passports use the LAB prefix.
 *
 * The same seed always produces exactly the same profiles (reproducible).
 */

const crypto = require('node:crypto');
const { ROOM_TYPES, ROOM_RATES } = require('../fields');

function makeRng(seedText) {
  // mulberry32 seeded with the SHA-256 of the text.
  let a = crypto.createHash('sha256').update(seedText).digest().readUInt32LE(0);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    digits: (n) => Array.from({ length: n }, () => Math.floor(next() * 10)).join(''),
  };
}

const MX_FIRST_F = ['Ana Lucía', 'María Fernanda', 'Sofía', 'Valeria', 'Ximena', 'Camila', 'Regina', 'Daniela', 'Guadalupe', 'Mariana', 'Andrea', 'Paola', 'Renata', 'Itzel', 'Jimena', 'Natalia', 'Fernanda', 'Alejandra', 'Karla', 'Monserrat'];
const MX_FIRST_M = ['Luis Fernando', 'José Manuel', 'Carlos', 'Diego', 'Santiago', 'Emiliano', 'Miguel Ángel', 'Jorge', 'Ricardo', 'Alejandro', 'Eduardo', 'Rodrigo', 'Javier', 'Arturo', 'Héctor', 'Iván', 'Leonardo', 'Mateo', 'Sebastián', 'Raúl'];
const MX_LAST = ['Martínez', 'Gómez', 'Hernández', 'López', 'García', 'Rodríguez', 'Pérez', 'Sánchez', 'Ramírez', 'Torres', 'Flores', 'Rivera', 'Cruz', 'Morales', 'Ortega', 'Castillo', 'Vargas', 'Mendoza', 'Ruiz', 'Navarro', 'Silva', 'Romero', 'Aguilar', 'Salazar', 'Delgado', 'Ibarra', 'Valenzuela', 'Soto'];
const INT_FIRST = ['Emily', 'James', 'Olivia', 'Liam', 'Chloe', 'Noah', 'Hannah', 'Lucas', 'Emma', 'Ethan', 'Mia', 'Oliver', 'Yuki', 'Haruto', 'Lena', 'Jonas', 'Camille', 'Hugo', 'Beatriz', 'João', 'Isabella', 'Martin', 'Lucía', 'Pablo'];
const INT_LAST = ['Johnson', 'Smith', 'Brown', 'Taylor', 'Wilson', 'Anderson', 'Clark', 'Tanaka', 'Sato', 'Müller', 'Schmidt', 'Dubois', 'Moreau', 'Silva', 'Costa', 'Fernández', 'Álvarez', 'González', 'Rossi', 'Novak'];
const CHILD_NAMES = ['Mateo', 'Sofía', 'Emma', 'Leo', 'Valentina', 'Tomás', 'Lucía', 'Nico', 'Julia', 'Bruno', 'Isabel', 'Dante', 'Mila', 'Gael', 'Renata'];

const CITIES = [
  // [city, country, time zone, currency, language, area code, ZIP prefix, weight]
  ['Tijuana', 'Mexico', 'America/Tijuana', 'MXN', 'Spanish', '664', '22', 14],
  ['Mexicali', 'Mexico', 'America/Tijuana', 'MXN', 'Spanish', '686', '21', 8],
  ['Ensenada', 'Mexico', 'America/Tijuana', 'MXN', 'Spanish', '646', '22', 6],
  ['Mexico City', 'Mexico', 'America/Mexico_City', 'MXN', 'Spanish', '55', '06', 10],
  ['Guadalajara', 'Mexico', 'America/Mexico_City', 'MXN', 'Spanish', '33', '44', 7],
  ['Monterrey', 'Mexico', 'America/Monterrey', 'MXN', 'Spanish', '81', '64', 7],
  ['Hermosillo', 'Mexico', 'America/Hermosillo', 'MXN', 'Spanish', '662', '83', 4],
  ['Merida', 'Mexico', 'America/Merida', 'MXN', 'Spanish', '999', '97', 3],
  ['Queretaro', 'Mexico', 'America/Mexico_City', 'MXN', 'Spanish', '442', '76', 3],
  ['La Paz', 'Mexico', 'America/Mazatlan', 'MXN', 'Spanish', '612', '23', 2],
  ['San Diego', 'United States', 'America/Los_Angeles', 'USD', 'English', '619', '92', 8],
  ['Los Angeles', 'United States', 'America/Los_Angeles', 'USD', 'English', '213', '90', 5],
  ['Phoenix', 'United States', 'America/Phoenix', 'USD', 'English', '602', '85', 3],
  ['Houston', 'United States', 'America/Chicago', 'USD', 'English', '713', '77', 2],
  ['Vancouver', 'Canada', 'America/Vancouver', 'CAD', 'English', '604', 'V6', 2],
  ['Madrid', 'Spain', 'Europe/Madrid', 'EUR', 'Spanish', '91', '28', 2],
  ['Bogota', 'Colombia', 'America/Bogota', 'COP', 'Spanish', '601', '11', 2],
  ['Buenos Aires', 'Argentina', 'America/Argentina/Buenos_Aires', 'ARS', 'Spanish', '11', 'C1', 2],
  ['Santiago', 'Chile', 'America/Santiago', 'CLP', 'Spanish', '2', '83', 1],
  ['Lima', 'Peru', 'America/Lima', 'PEN', 'Spanish', '1', '15', 1],
  ['Sao Paulo', 'Brazil', 'America/Sao_Paulo', 'BRL', 'Portuguese', '11', '01', 2],
  ['Berlin', 'Germany', 'Europe/Berlin', 'EUR', 'German', '30', '10', 1],
  ['Paris', 'France', 'Europe/Paris', 'EUR', 'French', '1', '75', 1],
  ['Tokyo', 'Japan', 'Asia/Tokyo', 'JPY', 'Japanese', '3', '10', 1],
];
const CITY_BAG = CITIES.flatMap((c) => Array(c[7]).fill(c));

const STREETS = ['Fictional Street', 'Laboratory Avenue', 'Example Boulevard', 'Simulated Road', 'Test Drive', 'Demo Lane', 'Imaginary Way'];
const NEIGHBORHOODS = ['Lab District', 'Synthetic Data Heights', 'Example Park', 'North Test', 'South Demo'];
const COMPANIES = [
  ['Pacific Digital', 'Pacific Digital Lab, S.A. de C.V.'],
  ['Frontier Logistics Demo', 'Frontier Logistics Demo, S. de R.L. de C.V.'],
  ['Baja Fictional Consulting', 'Baja Fictional Consulting, S.C.'],
  ['Example Manufacturing', 'Example Manufacturing, S.A.P.I. de C.V.'],
  ['Simulated Tourism', 'Simulated Tourism International, S.A. de C.V.'],
  ['Test Cloud Software', 'Test Cloud Software, S.A. de C.V.'],
  ['Imaginary Valley Agro', 'Imaginary Valley Agro, S.P.R. de R.L.'],
  ['Wellness Demo Clinic', 'Wellness Demo Clinic, S.C.'],
  ['Acme Test Corp', 'Acme Test Corporation (Fictitious) Inc.'],
  ['Fictional Northern University', 'Fictional Education Association, A.C.'],
  ['Self-employed', 'Sole proprietor (fictional)'],
];
// TEST card numbers published by payment processors. They are not real credentials.
const TEST_CARDS = ['4111 1111 1111 1111', '4242 4242 4242 4242', '4012 8888 8888 1881', '5555 5555 5555 4444', '5105 1051 0510 5100', '3782 822463 10005', '6011 1111 1111 1117'];
const INCOME = ['Under MXN 150,000', 'MXN 150,000 to 300,000', 'MXN 300,000 to 600,000', 'MXN 600,000 to 1,200,000', 'Over MXN 1,200,000'];

const OPS = {
  rooms: ['Single', 'Double', 'Junior Suite', 'Executive Suite', 'Family'],
  beds: ['Single', 'Full', 'Queen', 'King', 'Two beds'],
  floors: ['Low', 'Middle', 'High', 'No preference'],
  views: ['Ocean', 'City', 'Garden', 'Mountain', 'No preference'],
  pillows: ['Feather', 'Memory foam', 'Hypoallergenic', 'Firm', 'Soft'],
  checkin: ['13:00', '14:00', '15:00', '16:00', '18:00', '21:00'],
  checkout: ['08:00', '10:00', '11:00', '12:00'],
  breakfast: ['Continental', 'American', 'Mexican', 'Vegetarian', 'Vegan', 'No breakfast'],
  wifi: ['Basic', 'Remote work', 'Streaming', 'Not used'],
  tiers: ['Bronze', 'Bronze', 'Silver', 'Silver', 'Gold', 'Platinum'],
  channels: ['Email', 'SMS', 'WhatsApp', 'Phone call', 'Hotel app'],
  amenities: ['Pool', 'Spa', 'Gym', 'Restaurant', 'Bar', 'Business center', 'Kids club'],
};

const ascii = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z ]/g, '');

function clabe(rng) {
  const base = `999180${rng.digits(11)}`;
  const weights = [3, 7, 1];
  const sum = base.split('').reduce((acc, d, i) => acc + ((Number(d) * weights[i % 3]) % 10), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function phone(rng, city) {
  const [, country, , , , lada] = city;
  if (country === 'United States' || country === 'Canada') return `+1 ${lada} 555 01${rng.digits(2)}`;
  if (country === 'Mexico') {
    const rest = 10 - lada.length - 3;
    return `+52 ${lada} 555 ${rng.digits(rest)}`;
  }
  return `+00 ${lada} 555 ${rng.digits(4)} (fictional)`;
}

function personName(rng) {
  const mexican = rng.chance(0.72);
  if (mexican) {
    const female = rng.chance(0.5);
    const first = rng.pick(female ? MX_FIRST_F : MX_FIRST_M);
    return { first, last: `${rng.pick(MX_LAST)} ${rng.pick(MX_LAST)}`, mexican };
  }
  return { first: rng.pick(INT_FIRST), last: rng.pick(INT_LAST), mexican };
}

function rfcFor(first, last, dob, rng) {
  const l = ascii(last).toUpperCase().replace(/ /g, '');
  const f = ascii(first).toUpperCase().replace(/ /g, '');
  const vowel = (l.slice(1).match(/[AEIOU]/) || ['X'])[0];
  const second = ascii(last.split(' ')[1] || 'X').toUpperCase()[0] || 'X';
  const yymmdd = dob.slice(2, 4) + dob.slice(5, 7) + dob.slice(8, 10);
  return `${l[0]}${vowel}${second}${f[0]}${yymmdd}LB${rng.int(0, 9)}`;
}

function address(rng, city) {
  return `${rng.pick(STREETS)} ${rng.int(10, 9899)}, ${rng.pick(NEIGHBORHOODS)}, ${city[0]}, ${city[1]}, ZIP ${city[6]}${rng.digits(3)}`;
}

function buildProfile(rng, index, overrides = {}) {
  const city = overrides.city ? CITIES.find((c) => c[0] === overrides.city) : rng.pick(CITY_BAG);
  const name = overrides.first ? { first: overrides.first, last: overrides.last, mexican: true } : personName(rng);
  const fullName = `${name.first} ${name.last}`;
  const firstToken = ascii(name.first.split(' ')[0]).toLowerCase();
  const lastToken = ascii(name.last.split(' ')[0]).toLowerCase();
  const year = rng.int(1958, 2003);
  const dob = `${year}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
  const company = rng.pick(COMPANIES);
  const guestsCount = rng.pick([0, 0, 1, 1, 2]);
  const guests = Array.from({ length: guestsCount }, () => {
    const g = personName(rng);
    return `${g.first} ${g.last}`;
  });
  const childrenCount = rng.pick([0, 0, 0, 1, 2]);
  const children = Array.from({ length: childrenCount }, () => `${rng.pick(CHILD_NAMES)} (${rng.int(2, 15)} years old, fictional)`);
  const emergency = personName(rng);
  const tier = rng.pick(OPS.tiers);
  const statusRoll = rng.next();
  const status = statusRoll < 0.7 ? 'active' : statusRoll < 0.82 ? 'vip' : statusRoll < 0.95 ? 'inactive' : 'suspended';
  const expYear = rng.int(2027, 2031);
  const balance = rng.chance(0.55) ? 0 : rng.int(250, 48000) + rng.int(0, 99) / 100;

  const sensitive = {
    phone_number: phone(rng, city),
    personal_email: `${firstToken}.${lastToken}${String(index).padStart(3, '0')}@fictional-mail.test`,
    home_address: address(rng, city),
    billing_address: rng.chance(0.6) ? 'Same as home address' : address(rng, city),
    date_of_birth: dob,
    tax_id_rfc: rfcFor(name.first, name.last, dob, rng),
    passport_number: `LAB${rng.digits(6)}`,
    card_number: rng.pick(TEST_CARDS),
    cardholder_name: ascii(fullName).toUpperCase(),
    card_expiration: `${String(rng.int(1, 12)).padStart(2, '0')}/${expYear}`,
    bank_account_number: `LAB-${rng.digits(10)}`,
    clabe: clabe(rng),
    annual_income_range: rng.pick(INCOME),
    outstanding_balance: `MXN ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    employer_name: company[0],
    company_legal_name: company[1],
    room_guests: guests.length ? guests.join('; ') : 'None',
    accompanying_children: children.length ? children.join('; ') : 'None',
    emergency_contact_name: `${emergency.first} ${emergency.last}`,
    emergency_contact_phone: phone(rng, city),
  };

  const operational = {
    display_nickname: `${name.first.split(' ')[0]} ${name.last[0]}.`,
    city: city[0],
    country: city[1],
    preferred_language: city[4],
    time_zone: city[2],
    preferred_currency: city[3],
    preferred_room_category: rng.pick(OPS.rooms),
    preferred_bed_type: rng.pick(OPS.beds),
    preferred_floor: rng.pick(OPS.floors),
    preferred_room_view: rng.pick(OPS.views),
    preferred_pillow_type: rng.pick(OPS.pillows),
    preferred_checkin_time: rng.pick(OPS.checkin),
    preferred_checkout_time: rng.pick(OPS.checkout),
    breakfast_preference: rng.pick(OPS.breakfast),
    parking_required: rng.chance(0.45),
    wifi_usage_preference: rng.pick(OPS.wifi),
    newsletter_opt_in: rng.chance(0.4),
    loyalty_tier: tier,
    preferred_contact_channel: rng.pick(OPS.channels),
    favorite_amenity: childrenCount ? 'Kids club' : rng.pick(OPS.amenities),
  };

  return { fullName, status: overrides.status || status, sensitive, operational };
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildReservations(rng, referenceDate, preferredRoom, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const offset = rng.int(-320, 200);
    const nights = rng.int(1, 7);
    const checkIn = addDays(referenceDate, offset);
    const checkOut = addDays(checkIn, nights);
    let status;
    if (checkOut <= referenceDate) status = rng.chance(0.88) ? 'checked_out' : 'cancelled';
    else if (checkIn <= referenceDate) status = 'checked_in';
    else status = rng.chance(0.75) ? 'confirmed' : rng.chance(0.6) ? 'pending' : 'cancelled';
    const roomType = rng.chance(0.6) ? preferredRoom : rng.pick(ROOM_TYPES);
    out.push({
      room_type: roomType,
      room_number: `${rng.int(1, 9)}${String(rng.int(1, 30)).padStart(2, '0')}`,
      check_in: checkIn,
      check_out: checkOut,
      guests_count: rng.int(1, 4),
      status,
      total_amount: ROOM_RATES[roomType] * nights,
    });
  }
  return out;
}

// The first three customers are fixed so the documentation can refer to them.
const FIXED = [
  { first: 'Ana Lucía', last: 'Martínez Ruiz', city: 'Tijuana', status: 'vip' },
  { first: 'Luis Fernando', last: 'Gómez Ortega', city: 'Mexicali', status: 'active' },
  { first: 'Emily', last: 'Johnson', city: 'San Diego', status: 'active' },
];

function generateSeedData({ count, seed, referenceDate }) {
  const rng = makeRng(seed);
  const customers = [];
  for (let i = 1; i <= count; i += 1) {
    const profile = buildProfile(rng, i, FIXED[i - 1] || {});
    profile.index = i;
    profile.username = `customer${String(i).padStart(3, '0')}@hotel-lab.test`;
    profile.customerCode = `CUS-${String(i).padStart(4, '0')}`;
    profile.reservations = buildReservations(rng, referenceDate, profile.operational.preferred_room_category, rng.int(1, 3));
    customers.push(profile);
  }
  return customers;
}

function randomProfile() {
  const rng = makeRng(crypto.randomBytes(16).toString('hex'));
  return buildProfile(rng, rng.int(500, 999));
}

module.exports = { generateSeedData, randomProfile, makeRng };
