'use strict';

/**
 * Clasificacion de datos del perfil de cliente.
 *
 * - 20 campos SENSIBLES: cifrados con AES-256-GCM usando el DEK de cada cliente.
 *   Se guardan en customer_sensitive_data.encrypted_fields (JSONB).
 * - 20 campos OPERATIVOS de menor sensibilidad (para este escenario educativo):
 *   columnas normales de la tabla customers, protegidas por autenticacion/autorizacion
 *   pero SIN cifrado a nivel de aplicacion.
 */

const SENSITIVE_FIELDS = [
  { key: 'phone_number', label: 'Teléfono personal', group: 'contact', staff: true },
  { key: 'personal_email', label: 'Correo personal', group: 'contact', staff: true },
  { key: 'home_address', label: 'Domicilio particular', group: 'contact' },
  { key: 'billing_address', label: 'Dirección de facturación', group: 'contact' },
  { key: 'date_of_birth', label: 'Fecha de nacimiento', group: 'identity' },
  { key: 'tax_id_rfc', label: 'RFC (ficticio)', group: 'identity' },
  { key: 'passport_number', label: 'Pasaporte (ficticio)', group: 'identity' },
  { key: 'card_number', label: 'Tarjeta de prueba (no valida)', group: 'financial' },
  { key: 'cardholder_name', label: 'Titular de la tarjeta', group: 'financial' },
  { key: 'card_expiration', label: 'Vencimiento de tarjeta (MM/AAAA)', group: 'financial' },
  { key: 'bank_account_number', label: 'Cuenta bancaria (ficticia)', group: 'financial' },
  { key: 'clabe', label: 'CLABE (ficticia, banco 999)', group: 'financial' },
  { key: 'annual_income_range', label: 'Rango de ingreso anual', group: 'financial' },
  { key: 'outstanding_balance', label: 'Saldo pendiente', group: 'financial' },
  { key: 'employer_name', label: 'Empleador', group: 'employment' },
  { key: 'company_legal_name', label: 'Razón social de la empresa', group: 'employment' },
  { key: 'room_guests', label: 'Otros huéspedes en la habitación', group: 'family', staff: true },
  { key: 'accompanying_children', label: 'Menores acompañantes', group: 'family', staff: true },
  { key: 'emergency_contact_name', label: 'Contacto de emergencia', group: 'emergency', staff: true },
  { key: 'emergency_contact_phone', label: 'Teléfono de emergencia', group: 'emergency', staff: true },
];

const OPERATIONAL_FIELDS = [
  { key: 'display_nickname', label: 'Apodo para mostrar', type: 'text' },
  { key: 'city', label: 'Ciudad', type: 'text' },
  { key: 'country', label: 'País', type: 'text' },
  { key: 'preferred_language', label: 'Idioma preferido', type: 'select', options: ['Español', 'Inglés', 'Francés', 'Alemán', 'Portugués', 'Japonés'] },
  { key: 'time_zone', label: 'Zona horaria', type: 'text' },
  { key: 'preferred_currency', label: 'Moneda preferida', type: 'select', options: ['MXN', 'USD', 'CAD', 'EUR', 'COP', 'ARS', 'CLP', 'PEN', 'BRL', 'JPY'] },
  { key: 'preferred_room_category', label: 'Categoría de habitación', type: 'select', options: ['Sencilla', 'Doble', 'Suite Junior', 'Suite Ejecutiva', 'Familiar'] },
  { key: 'preferred_bed_type', label: 'Tipo de cama', type: 'select', options: ['Individual', 'Matrimonial', 'Queen', 'King', 'Dos camas'] },
  { key: 'preferred_floor', label: 'Piso preferido', type: 'select', options: ['Bajo', 'Medio', 'Alto', 'Sin preferencia'] },
  { key: 'preferred_room_view', label: 'Vista preferida', type: 'select', options: ['Mar', 'Ciudad', 'Jardín', 'Montaña', 'Sin preferencia'] },
  { key: 'preferred_pillow_type', label: 'Tipo de almohada', type: 'select', options: ['Pluma', 'Memory foam', 'Hipoalergénica', 'Firme', 'Suave'] },
  { key: 'preferred_checkin_time', label: 'Hora de llegada preferida', type: 'time' },
  { key: 'preferred_checkout_time', label: 'Hora de salida preferida', type: 'time' },
  { key: 'breakfast_preference', label: 'Preferencia de desayuno', type: 'select', options: ['Continental', 'Americano', 'Mexicano', 'Vegetariano', 'Vegano', 'Sin desayuno'] },
  { key: 'parking_required', label: 'Requiere estacionamiento', type: 'bool' },
  { key: 'wifi_usage_preference', label: 'Uso de Wi-Fi', type: 'select', options: ['Básico', 'Trabajo remoto', 'Streaming', 'No usa'] },
  { key: 'newsletter_opt_in', label: 'Suscrito al boletín', type: 'bool' },
  { key: 'loyalty_tier', label: 'Nivel de lealtad', type: 'select', options: ['Bronce', 'Plata', 'Oro', 'Platino'] },
  { key: 'preferred_contact_channel', label: 'Canal de contacto preferido', type: 'select', options: ['Correo', 'SMS', 'WhatsApp', 'Llamada', 'App del hotel'] },
  { key: 'favorite_amenity', label: 'Amenidad favorita', type: 'select', options: ['Alberca', 'Spa', 'Gimnasio', 'Restaurante', 'Bar', 'Centro de negocios', 'Club infantil'] },
];

const SENSITIVE_KEYS = SENSITIVE_FIELDS.map((f) => f.key);
const OPERATIONAL_KEYS = OPERATIONAL_FIELDS.map((f) => f.key);
const STAFF_REVEALABLE = SENSITIVE_FIELDS.filter((f) => f.staff).map((f) => f.key);

const GROUPS = {
  contact: 'Contacto',
  identity: 'Identidad',
  financial: 'Financiero',
  employment: 'Empleo',
  family: 'Acompañantes',
  emergency: 'Emergencia',
};

// Pestanas de la vista de perfil y los grupos que muestran.
const PROFILE_TABS = {
  personal: ['contact', 'identity', 'emergency'],
  financial: ['financial', 'employment'],
  family: ['family'],
};

const CUSTOMER_STATUSES = ['active', 'vip', 'inactive', 'suspended'];
const STATUS_LABELS = { active: 'Activo', vip: 'VIP', inactive: 'Inactivo', suspended: 'Suspendido' };
const RESERVATION_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'];
const RESERVATION_LABELS = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  checked_in: 'Hospedado',
  checked_out: 'Concluida',
  cancelled: 'Cancelada',
};
const ROOM_TYPES = ['Sencilla', 'Doble', 'Suite Junior', 'Suite Ejecutiva', 'Familiar'];
const ROOM_RATES = { Sencilla: 1450, Doble: 1890, 'Suite Junior': 2900, 'Suite Ejecutiva': 4200, Familiar: 3300 };

if (SENSITIVE_FIELDS.length !== 20 || OPERATIONAL_FIELDS.length !== 20) {
  throw new Error('La clasificacion debe tener exactamente 20 campos sensibles y 20 operativos');
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
