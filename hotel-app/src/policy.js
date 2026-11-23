'use strict';

/**
 * Object-level authorization (BOLA/IDOR prevention).
 * These rules are enforced in the BACKEND on every request; hiding buttons in the GUI
 * is not a security control.
 *
 *  admin    : all customers; may reveal all 20 fields (audited demonstration action).
 *  staff    : all customers (operational data and reservations); may only reveal the
 *             fields needed for the stay (contact, accompanying guests, emergency).
 *  customer : only their own profile and reservations; may reveal their own 20 fields.
 */

const { SENSITIVE_KEYS, STAFF_REVEALABLE } = require('./fields');

class ForbiddenError extends Error {
  constructor(message = 'You are not authorized to access this resource.') {
    super(message);
    this.code = 'FORBIDDEN';
    this.status = 403;
  }
}

const isStaffOrAdmin = (user) => user && (user.role === 'admin' || user.role === 'staff');

function canViewCustomer(user, customer) {
  if (!user || !customer) return false;
  if (isStaffOrAdmin(user)) return true;
  return user.role === 'customer' && Number(customer.user_id) === Number(user.id);
}

function revealableFields(user, customer) {
  if (!canViewCustomer(user, customer)) return [];
  if (user.role === 'admin' || user.role === 'customer') return SENSITIVE_KEYS.slice();
  if (user.role === 'staff') return STAFF_REVEALABLE.slice();
  return [];
}

function canListCustomers(user) {
  return isStaffOrAdmin(user);
}

function canManageReservationFor(user, customer) {
  return canViewCustomer(user, customer);
}

module.exports = { ForbiddenError, canViewCustomer, revealableFields, canListCustomers, canManageReservationFor, isStaffOrAdmin };
