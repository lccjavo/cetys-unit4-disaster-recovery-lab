/* Comportamiento comun de la interfaz (sin scripts en linea, compatible con CSP). */
(function () {
  'use strict';

  // 1) Validacion de formularios Bootstrap + indicador de carga al enviar.
  document.querySelectorAll('form').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (form.classList.contains('needs-validation') && !form.checkValidity()) {
        event.preventDefault();
        event.stopPropagation();
        form.classList.add('was-validated');
        return;
      }
      form.classList.add('was-validated');
      var btn = form.querySelector('button[type="submit"][data-loading-text]');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>' + btn.getAttribute('data-loading-text');
      }
      if (form.hasAttribute('data-overlay')) {
        var ov = document.getElementById('loadingOverlay');
        if (ov) ov.classList.add('show');
      }
    });
  });

  // 2) Dialogo de confirmacion para acciones destructivas.
  //    <button data-confirm="texto" data-confirm-form="idFormulario" data-confirm-title="..." data-confirm-word="PALABRA">
  var modalEl = document.getElementById('confirmModal');
  if (modalEl && window.bootstrap) {
    var modal = new window.bootstrap.Modal(modalEl);
    var pendingForm = null;
    var wordWrap = modalEl.querySelector('[data-role="word-wrap"]');
    var wordInput = modalEl.querySelector('[data-role="word-input"]');
    var wordLabel = modalEl.querySelector('[data-role="word"]');
    var okBtn = modalEl.querySelector('[data-role="ok"]');
    var requiredWord = '';

    document.querySelectorAll('[data-confirm]').forEach(function (trigger) {
      trigger.addEventListener('click', function (event) {
        event.preventDefault();
        pendingForm = document.getElementById(trigger.getAttribute('data-confirm-form')) || trigger.closest('form');
        modalEl.querySelector('[data-role="title"]').textContent = trigger.getAttribute('data-confirm-title') || 'Confirmar accion';
        modalEl.querySelector('[data-role="body"]').textContent = trigger.getAttribute('data-confirm');
        requiredWord = trigger.getAttribute('data-confirm-word') || '';
        okBtn.className = 'btn ' + (trigger.getAttribute('data-confirm-variant') || 'btn-danger');
        if (requiredWord) {
          wordWrap.classList.remove('d-none');
          wordLabel.textContent = requiredWord;
          wordInput.value = '';
          okBtn.disabled = true;
        } else {
          wordWrap.classList.add('d-none');
          okBtn.disabled = false;
        }
        modal.show();
      });
    });
    if (wordInput) {
      wordInput.addEventListener('input', function () {
        okBtn.disabled = wordInput.value.trim() !== requiredWord;
      });
    }
    okBtn.addEventListener('click', function () {
      if (!pendingForm) return;
      if (requiredWord) {
        var hidden = pendingForm.querySelector('input[name="confirm"]');
        if (hidden) hidden.value = wordInput.value.trim();
      }
      modal.hide();
      var ov = document.getElementById('loadingOverlay');
      if (ov) ov.classList.add('show');
      pendingForm.submit();
    });
  }

  // 3) Envio automatico de filtros al cambiar un select.
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { el.form.submit(); });
  });

  // 4) Revelar informacion sensible (llama al backend; la autorizacion se valida en el servidor).
  var csrf = document.querySelector('meta[name="csrf-token"]');
  document.querySelectorAll('[data-reveal-group]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var customerId = btn.getAttribute('data-customer-id');
      var fields = btn.getAttribute('data-fields').split(',').filter(Boolean);
      var container = document.querySelector(btn.getAttribute('data-target'));
      var status = container.querySelector('[data-role="reveal-status"]');
      var original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Descifrando...';
      fetch('/customers/' + encodeURIComponent(customerId) + '/reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf ? csrf.content : '' },
        body: JSON.stringify({ fields: fields }),
        credentials: 'same-origin'
      }).then(function (res) {
        return res.json().then(function (json) { return { ok: res.ok, json: json }; });
      }).then(function (r) {
        if (!r.ok) {
          showStatus(status, 'danger', r.json.message || 'No fue posible descifrar.', r.json.error);
          container.querySelectorAll('[data-field]').forEach(function (el) {
            if (fields.indexOf(el.getAttribute('data-field')) >= 0) {
              el.innerHTML = '<span class="badge text-bg-secondary"><i class="bi bi-lock-fill me-1"></i>No disponible temporalmente</span>';
            }
          });
          btn.disabled = false;
          btn.innerHTML = original;
          return;
        }
        Object.keys(r.json.values).forEach(function (key) {
          var el = container.querySelector('[data-field="' + key + '"]');
          if (el) {
            el.textContent = r.json.values[key];
            el.classList.remove('masked');
            el.classList.add('text-success-emphasis');
          }
        });
        (r.json.denied || []).forEach(function (key) {
          var el = container.querySelector('[data-field="' + key + '"]');
          if (el) el.innerHTML = '<span class="badge text-bg-warning"><i class="bi bi-shield-lock me-1"></i>Sin autorizacion para su rol</span>';
        });
        showStatus(status, 'success', 'Descifrado con el DEK del cliente, desenvuelto por el Key Vault con ' + r.json.kek_id + ' en ' + r.json.elapsed_ms + ' ms.');
        btn.innerHTML = '<i class="bi bi-eye me-1"></i>Informacion revelada';
      }).catch(function () {
        showStatus(status, 'danger', 'Error de red al contactar el servidor.');
        btn.disabled = false;
        btn.innerHTML = original;
      });
    });
  });

  function showStatus(el, type, message, code) {
    if (!el) return;
    el.className = 'alert alert-' + type + ' py-2 small mb-3';
    el.textContent = (code ? '[' + code + '] ' : '') + message;
  }

  // 5) Generador de datos ficticios para el formulario de nuevo cliente.
  var gen = document.getElementById('generateFakeCustomer');
  if (gen) {
    gen.addEventListener('click', function () {
      gen.disabled = true;
      fetch('/customers/generate', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          Object.keys(data).forEach(function (k) {
            var input = document.querySelector('[name="' + k + '"]');
            if (!input) return;
            if (input.type === 'checkbox') input.checked = Boolean(data[k]);
            else input.value = data[k];
          });
        })
        .finally(function () { gen.disabled = false; });
    });
  }

  // 6) Auto-actualizacion opcional (pagina de recuperacion durante simulaciones).
  var refresh = document.querySelector('[data-autorefresh]');
  if (refresh) {
    var seconds = Number(refresh.getAttribute('data-autorefresh')) || 5;
    var toggle = document.getElementById('autoRefreshToggle');
    setInterval(function () {
      if (!toggle || toggle.checked) window.location.reload();
    }, seconds * 1000);
  }

  // 7) Activar pestana indicada en el hash (#tab-...).
  if (window.location.hash && window.bootstrap) {
    var tabBtn = document.querySelector('[data-bs-target="' + window.location.hash + '"]');
    if (tabBtn) new window.bootstrap.Tab(tabBtn).show();
  }
})();
