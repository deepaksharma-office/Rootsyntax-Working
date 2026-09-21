if (!customElements.get('cust-consultation-form')) {
  class CustConsultationForm extends HTMLElement {
    connectedCallback() {
      if (this._connected) return;
      this._connected = true;
      this._form = this.querySelector('form');
      if (!this._form) return;
      this._button = this._form.querySelector('[type="submit"]');
      this._buttonLabel = this._button?.querySelector('span');
      this._originalLabel = this._buttonLabel?.textContent || '';
      this._status = this._form.querySelector('.cust__consultation-status');
      this._controller = new AbortController();
      this._form.addEventListener('submit', (event) => this._submit(event), { signal: this._controller.signal });
      this._form.addEventListener('input', (event) => this._clearFieldError(event.target), { signal: this._controller.signal });
      this._form.addEventListener('invalid', (event) => {
        const input = event.target;
        const message = this._form.dataset[`${input.name}Error`];
        if (!message) return;
        const error = this._form.querySelector(`[data-field-error="${input.name}"]`);
        if (error) error.textContent = message;
        input.setAttribute('aria-invalid', 'true');
      }, { capture: true, signal: this._controller.signal });

      if (!this._endpoint()) {
        if (this._button) this._button.disabled = true;
        this._setStatus('Form temporarily unavailable.', 'error');
      }
    }

    disconnectedCallback() {
      this._controller?.abort();
      this._connected = false;
    }

    _endpoint() {
      try {
        const raw = this._form.dataset.proxyPath;
        if (!raw) return null;
        const url = new URL(raw, location.origin);
        if (url.origin !== location.origin || !/^\/apps\/[a-z0-9][a-z0-9_-]*(?:\/.*)?$/i.test(url.pathname)) return null;
        return url;
      } catch {
        return null;
      }
    }

    _setStatus(message, state = '') {
      if (!this._status) return;
      this._status.textContent = message;
      this._status.dataset.state = state;
    }

    _clearFieldError(input) {
      if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
      input.removeAttribute('aria-invalid');
      const error = this._form.querySelector(`[data-field-error="${input.name}"]`);
      if (error) error.textContent = '';
    }

    _showFieldErrors(errors) {
      let firstInvalid = null;
      for (const [name, message] of Object.entries(errors || {})) {
        if (!['name', 'email', 'phone', 'service', 'website', 'message'].includes(name)) continue;
        const input = this._form.elements.namedItem(name);
        const error = this._form.querySelector(`[data-field-error="${name}"]`);
        if (!input || !error) continue;
        input.setAttribute('aria-invalid', 'true');
        error.textContent = String(message).slice(0, 160);
        firstInvalid ||= input;
      }
      firstInvalid?.focus();
    }

    _attribution() {
      const privacy = window.Shopify?.customerPrivacy;
      if (!privacy?.analyticsProcessingAllowed?.()) return {};
      const data = { tracking_allowed: true };
      if (this._form.dataset.trackPage === 'true') data.page_url = location.href.slice(0, 1000);
      if (this._form.dataset.trackReferrer === 'true') data.referrer = document.referrer.slice(0, 1000);
      if (this._form.dataset.trackUtm === 'true') {
        const params = new URLSearchParams(location.search);
        for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
          const value = params.get(key);
          if (value) data[key] = value.slice(0, 200);
        }
      }
      return data;
    }

    async _submit(event) {
      event.preventDefault();
      if (this._submitting) return;
      const endpoint = this._endpoint();
      if (!endpoint) {
        this._setStatus(this._form.dataset.errorMessage, 'error');
        return;
      }

      this._setStatus('');
      for (const input of this._form.elements) this._clearFieldError(input);
      const phoneInput = this._form.elements.namedItem('phone');
      if (phoneInput?.value && !/^\+[1-9][0-9]{7,14}$/.test(phoneInput.value.replace(/[\s().-]/g, ''))) {
        this._showFieldErrors({ phone: this._form.dataset.phoneError });
        return;
      }
      if (!this._form.reportValidity()) return;
      const formData = new FormData(this._form);
      if (!String(formData.get('email') || '').trim()) {
        this._showFieldErrors({ email: 'Enter your email address.' });
        return;
      }

      this._submitting = true;
      this._button.disabled = true;
      if (this._buttonLabel) this._buttonLabel.textContent = this._form.dataset.loadingText;
      try {
        const payload = Object.fromEntries(formData.entries());
        payload.source = 'shopify-consultation-form';
        payload.include_timestamp = this._form.dataset.includeTimestamp === 'true';
        payload.notify = this._form.dataset.notify === 'true';
        if (payload.notify) payload.notification_email = this._form.dataset.notificationEmail;
        Object.assign(payload, this._attribution());
        const response = await fetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.ok !== true) {
          if (result?.errors) this._showFieldErrors(result.errors);
          throw new Error('Submission failed');
        }
        this._form.reset();
        this._setStatus(this._form.dataset.successMessage, 'success');
      } catch {
        this._setStatus(this._form.dataset.errorMessage, 'error');
      } finally {
        this._submitting = false;
        this._button.disabled = false;
        if (this._buttonLabel) this._buttonLabel.textContent = this._originalLabel;
      }
    }
  }
  customElements.define('cust-consultation-form', CustConsultationForm);
}
