'use strict';

/**
 * Generador de datos 100% FICTICIOS.
 *
 * - Telefonos con el segmento 555 (MX) o 555-01xx (NANP, reservado para ficcion).
 * - Correos en el dominio reservado .test (RFC 2606).
 * - Tarjetas: numeros de PRUEBA publicos de la industria; no sirven para pagar. Sin CVV.
 * - RFC con homoclave terminada en "LB" (laboratorio); no corresponde a personas reales.
 * - CLABE con codigo de banco 999 (inexistente) y digito verificador calculado.
 * - Pasaportes con prefijo LAB.
 *
 * Con la misma semilla produce exactamente los mismos perfiles (reproducible).
 */

const crypto = require('node:crypto');
const { ROOM_TYPES, ROOM_RATES } = require('../fields');

function makeRng(seedText) {
  // mulberry32 sembrado con SHA-256 del texto.
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
  // [ciudad, pais, zona horaria, moneda, idioma, lada, cp-prefijo, peso]
  ['Tijuana', 'México', 'America/Tijuana', 'MXN', 'Español', '664', '22', 14],
  ['Mexicali', 'México', 'America/Tijuana', 'MXN', 'Español', '686', '21', 8],
  ['Ensenada', 'México', 'America/Tijuana', 'MXN', 'Español', '646', '22', 6],
  ['Ciudad de México', 'México', 'America/Mexico_City', 'MXN', 'Español', '55', '06', 10],
  ['Guadalajara', 'México', 'America/Mexico_City', 'MXN', 'Español', '33', '44', 7],
  ['Monterrey', 'México', 'America/Monterrey', 'MXN', 'Español', '81', '64', 7],
  ['Hermosillo', 'México', 'America/Hermosillo', 'MXN', 'Español', '662', '83', 4],
  ['Mérida', 'México', 'America/Merida', 'MXN', 'Español', '999', '97', 3],
  ['Querétaro', 'México', 'America/Mexico_City', 'MXN', 'Español', '442', '76', 3],
  ['La Paz', 'México', 'America/Mazatlan', 'MXN', 'Español', '612', '23', 2],
  ['San Diego', 'Estados Unidos', 'America/Los_Angeles', 'USD', 'Inglés', '619', '92', 8],
  ['Los Ángeles', 'Estados Unidos', 'America/Los_Angeles', 'USD', 'Inglés', '213', '90', 5],
  ['Phoenix', 'Estados Unidos', 'America/Phoenix', 'USD', 'Inglés', '602', '85', 3],
  ['Houston', 'Estados Unidos', 'America/Chicago', 'USD', 'Inglés', '713', '77', 2],
  ['Vancouver', 'Canadá', 'America/Vancouver', 'CAD', 'Inglés', '604', 'V6', 2],
  ['Madrid', 'España', 'Europe/Madrid', 'EUR', 'Español', '91', '28', 2],
  ['Bogotá', 'Colombia', 'America/Bogota', 'COP', 'Español', '601', '11', 2],
  ['Buenos Aires', 'Argentina', 'America/Argentina/Buenos_Aires', 'ARS', 'Español', '11', 'C1', 2],
  ['Santiago', 'Chile', 'America/Santiago', 'CLP', 'Español', '2', '83', 1],
  ['Lima', 'Perú', 'America/Lima', 'PEN', 'Español', '1', '15', 1],
  ['São Paulo', 'Brasil', 'America/Sao_Paulo', 'BRL', 'Portugués', '11', '01', 2],
  ['Berlín', 'Alemania', 'Europe/Berlin', 'EUR', 'Alemán', '30', '10', 1],
  ['París', 'Francia', 'Europe/Paris', 'EUR', 'Francés', '1', '75', 1],
  ['Tokio', 'Japón', 'Asia/Tokyo', 'JPY', 'Japonés', '3', '10', 1],
];
const CITY_BAG = CITIES.flatMap((c) => Array(c[7]).fill(c));

const STREETS = ['Calle Ficticia', 'Avenida del Laboratorio', 'Paseo de los Ejemplos', 'Calle Simulada', 'Boulevard de Prueba', 'Privada Demo', 'Calzada Imaginaria'];
const NEIGHBORHOODS = ['Col. Laboratorio', 'Col. Datos Sintéticos', 'Fracc. Ejemplo', 'Col. Prueba Norte', 'Col. Demo Sur'];
const COMPANIES = [
  ['Pacífico Digital', 'Pacífico Digital Laboratorio, S.A. de C.V.'],
  ['Logística Frontera Demo', 'Logística Frontera Demo, S. de R.L. de C.V.'],
  ['Consultores Baja Ficticia', 'Consultores Baja Ficticia, S.C.'],
  ['Manufacturas del Ejemplo', 'Manufacturas del Ejemplo, S.A.P.I. de C.V.'],
  ['Turismo Simulado', 'Turismo Simulado Internacional, S.A. de C.V.'],
  ['Software Nube Prueba', 'Software Nube Prueba, S.A. de C.V.'],
  ['Agro Valle Imaginario', 'Agro Valle Imaginario, S.P.R. de R.L.'],
  ['Clínica Bienestar Demo', 'Clínica Bienestar Demo, S.C.'],
  ['Acme Test Corp', 'Acme Test Corporation (Fictitious) Inc.'],
  ['Universidad Ficticia del Norte', 'Asociación Educativa Ficticia, A.C.'],
  ['Trabajador independiente', 'Persona física con actividad empresarial (ficticia)'],
];
// Numeros de tarjeta de PRUEBA publicados por procesadores de pago. No son credenciales reales.
const TEST_CARDS = ['4111 1111 1111 1111', '4242 4242 4242 4242', '4012 8888 8888 1881', '5555 5555 5555 4444', '5105 1051 0510 5100', '3782 822463 10005', '6011 1111 1111 1117'];
const INCOME = ['Menos de MXN 150,000', 'MXN 150,000 a 300,000', 'MXN 300,000 a 600,000', 'MXN 600,000 a 1,200,000', 'Más de MXN 1,200,000'];

const OPS = {
  rooms: ['Sencilla', 'Doble', 'Suite Junior', 'Suite Ejecutiva', 'Familiar'],
  beds: ['Individual', 'Matrimonial', 'Queen', 'King', 'Dos camas'],
  floors: ['Bajo', 'Medio', 'Alto', 'Sin preferencia'],
  views: ['Mar', 'Ciudad', 'Jardín', 'Montaña', 'Sin preferencia'],
  pillows: ['Pluma', 'Memory foam', 'Hipoalergénica', 'Firme', 'Suave'],
  checkin: ['13:00', '14:00', '15:00', '16:00', '18:00', '21:00'],
  checkout: ['08:00', '10:00', '11:00', '12:00'],
  breakfast: ['Continental', 'Americano', 'Mexicano', 'Vegetariano', 'Vegano', 'Sin desayuno'],
  wifi: ['Básico', 'Trabajo remoto', 'Streaming', 'No usa'],
  tiers: ['Bronce', 'Bronce', 'Plata', 'Plata', 'Oro', 'Platino'],
  channels: ['Correo', 'SMS', 'WhatsApp', 'Llamada', 'App del hotel'],
  amenities: ['Alberca', 'Spa', 'Gimnasio', 'Restaurante', 'Bar', 'Centro de negocios', 'Club infantil'],
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
  if (country === 'Estados Unidos' || country === 'Canadá') return `+1 ${lada} 555 01${rng.digits(2)}`;
  if (country === 'México') {
    const rest = 10 - lada.length - 3;
    return `+52 ${lada} 555 ${rng.digits(rest)}`;
  }
  return `+00 ${lada} 555 ${rng.digits(4)} (ficticio)`;
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
  return `${rng.pick(STREETS)} ${rng.int(10, 9899)}, ${rng.pick(NEIGHBORHOODS)}, ${city[0]}, ${city[1]}, CP ${city[6]}${rng.digits(3)}`;
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
  const children = Array.from({ length: childrenCount }, () => `${rng.pick(CHILD_NAMES)} (${rng.int(2, 15)} años, ficticio)`);
  const emergency = personName(rng);
  const tier = rng.pick(OPS.tiers);
  const statusRoll = rng.next();
  const status = statusRoll < 0.7 ? 'active' : statusRoll < 0.82 ? 'vip' : statusRoll < 0.95 ? 'inactive' : 'suspended';
  const expYear = rng.int(2027, 2031);
  const balance = rng.chance(0.55) ? 0 : rng.int(250, 48000) + rng.int(0, 99) / 100;

  const sensitive = {
    phone_number: phone(rng, city),
    personal_email: `${firstToken}.${lastToken}${String(index).padStart(3, '0')}@correo-ficticio.test`,
    home_address: address(rng, city),
    billing_address: rng.chance(0.6) ? 'Igual al domicilio particular' : address(rng, city),
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
    room_guests: guests.length ? guests.join('; ') : 'Ninguno',
    accompanying_children: children.length ? children.join('; ') : 'Ninguno',
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
    favorite_amenity: childrenCount ? 'Club infantil' : rng.pick(OPS.amenities),
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

// Los tres primeros clientes son fijos para que la documentacion pueda referirse a ellos.
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
    profile.username = `cliente${String(i).padStart(3, '0')}@hotel-lab.test`;
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
