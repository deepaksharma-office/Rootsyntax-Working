if (!customElements.get('cust-featured-testimonials')) {
  class CustFeaturedTestimonials extends HTMLElement {
    connectedCallback() {
      if (this._initialized) return;
      this._initialized = true;
      this._slides = Array.from(this.querySelectorAll('.cust__featured-slide'));
      if (!this._slides.length) return;

      this._index = Math.max(0, this._slides.findIndex((slide) => slide.classList.contains('cust__featured-slide--active')));
      this._controller = new AbortController();
      this._reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._hovered = false;
      this._focused = false;
      this._editorPaused = false;

      const options = { signal: this._controller.signal };
      const previous = this.querySelector('.cust__featured-nav-button--previous');
      const next = this.querySelector('.cust__featured-nav-button--next');
      previous?.addEventListener('click', () => this._show(this._index - 1, true), options);
      next?.addEventListener('click', () => this._show(this._index + 1, true), options);

      this.addEventListener('mouseenter', () => {
        this._hovered = true;
        this._syncAutoplay();
      }, options);
      this.addEventListener('mouseleave', () => {
        this._hovered = false;
        this._syncAutoplay();
      }, options);
      this.addEventListener('focusin', () => {
        this._focused = true;
        this._syncAutoplay();
      }, options);
      this.addEventListener('focusout', (event) => {
        if (this.contains(event.relatedTarget)) return;
        this._focused = false;
        this._syncAutoplay();
      }, options);
      this.addEventListener('shopify:block:select', (event) => {
        const slide = event.target.closest('.cust__featured-slide');
        if (!slide || !this.contains(slide)) return;
        this._editorPaused = true;
        this._show(this._slides.indexOf(slide));
      }, options);
      this.addEventListener('shopify:block:deselect', () => {
        this._editorPaused = false;
        this._syncAutoplay();
      }, options);
      document.addEventListener('visibilitychange', () => this._syncAutoplay(), options);
      this._onMotionChange = () => this._syncAutoplay();
      this._reducedMotion.addEventListener('change', this._onMotionChange);

      this._show(this._index);
      this._syncAutoplay();
    }

    disconnectedCallback() {
      this._stopAutoplay();
      this._controller?.abort();
      this._reducedMotion?.removeEventListener('change', this._onMotionChange);
      this._initialized = false;
    }

    _show(index, announce = false) {
      if (!this._slides?.length) return;
      this._index = (index + this._slides.length) % this._slides.length;

      this._slides.forEach((slide, slideIndex) => {
        const active = slideIndex === this._index;
        slide.classList.toggle('cust__featured-slide--active', active);
        if (active) {
          slide.removeAttribute('aria-hidden');
          const scrollArea = slide.querySelector('.cust__featured-scroll');
          if (scrollArea) scrollArea.scrollTop = 0;
        } else {
          slide.setAttribute('aria-hidden', 'true');
        }
        const scrollArea = slide.querySelector('.cust__featured-scroll');
        if (scrollArea) scrollArea.tabIndex = active ? 0 : -1;
      });

      const current = this.querySelector('.cust__featured-current');
      if (current) current.textContent = String(this._index + 1);
      const quoteColor = this._slides[this._index].dataset.quoteColor;
      if (quoteColor) this.style.setProperty('--cust-active-quote-color', quoteColor);
      else this.style.removeProperty('--cust-active-quote-color');

      if (announce) {
        const name = this._slides[this._index].querySelector('.cust__featured-customer-copy h3')?.textContent?.trim();
        const status = this.querySelector('.cust__featured-live');
        if (status) status.textContent = `Testimonial ${this._index + 1} of ${this._slides.length}${name ? `: ${name}` : ''}`;
        this._syncAutoplay();
      }
    }

    _stopAutoplay() {
      if (this._timer) window.clearInterval(this._timer);
      this._timer = null;
    }

    _syncAutoplay() {
      this._stopAutoplay();
      if (
        this.dataset.autoplay !== 'true' ||
        this._slides.length < 2 ||
        this._reducedMotion.matches ||
        document.hidden ||
        this._editorPaused ||
        (this.dataset.pauseHover === 'true' && this._hovered) ||
        (this.dataset.pauseFocus === 'true' && this._focused)
      ) return;

      const interval = Math.max(3000, Number(this.dataset.interval) || 5000);
      this._timer = window.setInterval(() => this._show(this._index + 1), interval);
    }
  }

  customElements.define('cust-featured-testimonials', CustFeaturedTestimonials);
}
