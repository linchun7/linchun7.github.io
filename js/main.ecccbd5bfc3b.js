(() => {
  'use strict';

  const i18n = window.CACTUS_I18N || {};
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

  function setExpanded(control, target, expanded) {
    if (!control || !target) return;
    control.setAttribute('aria-expanded', String(expanded));
    target.hidden = !expanded;
  }

  function toggleExpanded(control, target) {
    const next = control.getAttribute('aria-expanded') !== 'true';
    setExpanded(control, target, next);
    return next;
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  function copyFallback(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    textarea.remove();
    if (!success) throw new Error('Copy command failed');
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    copyFallback(text);
  }

  function setupCodeCopy() {
    document.querySelectorAll('figure.highlight').forEach((figure) => {
      const codeCells = figure.querySelectorAll('td.code');
      if (!codeCells.length || figure.querySelector(':scope > .btn-copy')) return;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-copy tooltipped tooltipped-sw';
      button.setAttribute('aria-label', i18n.copy || 'Copy code');
      button.innerHTML = '<svg class="icon-svg" aria-hidden="true" focusable="false"><use href="/vendor/fontawesome/icons.0f8d2dd5bd48.svg#fa-regular-clone"></use></svg>';

      button.addEventListener('click', async () => {
        const text = [...codeCells].map((cell) => cell.innerText).join('\n').replace(/\n+$/, '');
        try {
          await copyText(text);
          const original = i18n.copy || 'Copy code';
          button.setAttribute('aria-label', i18n.copied || 'Copied');
          window.setTimeout(() => button.setAttribute('aria-label', original), 1600);
        } catch (error) {
          console.warn('Copy failed:', error);
        }
      });

      figure.prepend(button);
    });
  }

  function setupHeaderNavigation() {
    const toggle = document.querySelector('#header .menu-toggle');
    const list = document.querySelector('#header #nav-list');
    if (!toggle || !list) return;

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(expanded));
      list.classList.toggle('responsive', expanded);
    });
  }

  function setupPostActions() {
    const menu = document.querySelector('#header-post #menu-panel');
    const menuControls = [...document.querySelectorAll('#menu-icon, #menu-icon-tablet')];
    const desktopNav = document.querySelector('#header-post #nav');

    const setMenuVisibility = (visible) => {
      if (!menu) return;
      menu.hidden = !visible;
      menuControls.forEach((control) => {
        control.classList.toggle('active', visible);
        control.setAttribute('aria-expanded', String(visible));
      });
    };

    if (menu && window.matchMedia('(min-width: 1440px)').matches) setMenuVisibility(true);

    menuControls.forEach((control) => {
      control.addEventListener('click', () => setMenuVisibility(menu?.hidden ?? true));
    });

    document.querySelectorAll('[data-scroll-top]').forEach((control) => {
      control.addEventListener('click', scrollToTop);
    });

    document.querySelectorAll('[data-toggle-target]').forEach((control) => {
      const selector = control.getAttribute('data-toggle-target');
      if (!selector) return;
      const target = document.querySelector(selector);
      if (!target) return;
      control.addEventListener('click', () => toggleExpanded(control, target));
    });

    const footer = document.querySelector('#footer-post');
    const tabletMenu = document.querySelector('#menu-icon-tablet');
    const tabletTop = document.querySelector('#top-icon-tablet');
    let previousScroll = window.scrollY;
    let ticking = false;

    const updateOnScroll = () => {
      const current = window.scrollY;
      const nearTop = current < 50;
      const scrolled = current > 100;

      if (menu && desktopNav) {
        if (nearTop) desktopNav.hidden = false;
        else if (scrolled) desktopNav.hidden = true;
      }

      if (tabletMenu && tabletTop) {
        tabletMenu.hidden = scrolled;
        tabletTop.hidden = !scrolled;
      }

      if (footer) {
        footer.hidden = current > previousScroll && current > 50;
        if (current !== previousScroll) {
          ['#nav-footer', '#toc-footer', '#share-footer'].forEach((selector) => {
            const panel = document.querySelector(selector);
            if (panel) panel.hidden = true;
          });
          document.querySelectorAll('#actions-footer [aria-expanded]').forEach((control) => {
            control.setAttribute('aria-expanded', 'false');
          });
        }
        const footerTop = document.querySelector('#actions-footer [data-scroll-top]');
        if (footerTop) footerTop.hidden = !scrolled;
      }

      previousScroll = Math.max(current, 0);
      ticking = false;
    };

    window.addEventListener('scroll', () => {
      if (!ticking) {
        window.requestAnimationFrame(updateOnScroll);
        ticking = true;
      }
    }, { passive: true });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupHeaderNavigation();
    setupPostActions();
    setupCodeCopy();
  });
})();
