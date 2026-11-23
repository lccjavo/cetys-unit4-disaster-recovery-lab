'use strict';

/**
 * Autorizacion a nivel de objeto (prevencion de BOLA/IDOR).
 * Estas reglas se aplican en el BACKEND en cada solicitud; ocultar botones en la GUI
 * no es un control de seguridad.
 *
 *  admin    : todos los clientes; puede revelar los 20 campos (accion de demostracion auditada).
 *  staff    : todos los clientes (datos operativos y reservaciones); solo puede revelar
 *             los campos necesarios para la estancia (contacto, acompanantes, emergencia).
 *  customer : solo su propio perfil y sus propias reservaciones; puede revelar sus 20 campos.
 */

const { SENSITIVE_KEYS, STAFF_REVEALABLE } = require('./fields');

class ForbiddenError extends Error {
  constructor(message = 'No tiene autorizacion para acceder a este recurso.') {
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
