(function () {
  'use strict';

  const validators = {
    name(value) {
      value = String(value || '').trim();
      if (!value) return 'Nama tidak boleh kosong';
      if (value.length < 3) return 'Nama minimal 3 karakter';
      if (!/^[a-zA-Z\s'-.]+$/.test(value)) return 'Nama hanya boleh mengandung huruf';
      return null;
    },
    phone(value) {
      value = String(value || '').trim().replace(/\s+/g, '');
      if (!value) return 'Nomor WhatsApp tidak boleh kosong';
      if (!/^(\+?62|0)8[0-9]{7,11}$/.test(value)) return 'Format nomor WhatsApp tidak valid (0812xxx)';
      return null;
    },
  };

  window.KothakValidators = validators;
})();
