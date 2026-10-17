const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function navigation({ scrollTop = 0, scrollHeight = 1500, clientHeight = 600, offsets = [800, 1200], reduceMotion = true } = {}) {
  const scroller = {
    scrollTop, scrollHeight, clientHeight,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTo({ top, behavior }) {
      if (behavior === 'smooth') return; // Scroll events arrive in later frames.
      this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
    },
  };
  const cards = [['save', offsets[0]], ['preview', offsets[1]]].map(([key, offset]) => ({
    getAttribute: () => key,
    getBoundingClientRect: () => ({ top: 100 + offset - scroller.scrollTop }),
  }));
  const context = loadFrontend('training-core', {
    window: { matchMedia: () => ({ matches: reduceMotion }) },
    document: {
      querySelector: selector => selector === '.main-content' ? scroller : cards[1],
      querySelectorAll: () => cards,
    },
  });
  const app = Object.assign({}, context.window.trainingCoreMixin, {
    activeSection: 'save', escapeAttr: value => value,
  });
  return { app, scroller };
}

test('a short final section becomes active at the bottom of the form', () => {
  const { app } = navigation({ scrollTop: 900 });
  app._updateActiveSection();
  assert.equal(app.activeSection, 'preview');
});

test('scrolling above the bottom keeps the section at the top active', () => {
  const { app } = navigation({ scrollTop: 895 });
  app._updateActiveSection();
  assert.equal(app.activeSection, 'save');
});

test('fractional scroll positions near the bottom still select the final section', () => {
  const { app } = navigation({ scrollTop: 899.5 });
  app._updateActiveSection();
  assert.equal(app.activeSection, 'preview');
});

test('a form that fits the viewport does not default to its final section', () => {
  const { app } = navigation({ scrollHeight: 500, offsets: [0, 300] });
  app._updateActiveSection();
  assert.equal(app.activeSection, 'save');
});

test('clicking the final section while already at the bottom updates selection without a scroll event', () => {
  const { app, scroller } = navigation({ scrollTop: 900 });
  app.scrollToSection('preview');
  assert.equal(scroller.scrollTop, 900);
  assert.equal(app.activeSection, 'preview');
});

test('smooth navigation does not flash the destination before scrolling past the previous section', () => {
  const { app, scroller } = navigation({ scrollTop: 850, reduceMotion: false });
  app.scrollToSection('preview');
  assert.equal(app.activeSection, 'save');
  scroller.scrollTop = 875;
  app._updateActiveSection();
  assert.equal(app.activeSection, 'save');
  scroller.scrollTop = 900;
  app._updateActiveSection();
  assert.equal(app.activeSection, 'preview');
});

test('smooth navigation already at the bottom still selects the destination without scrolling', () => {
  const { app } = navigation({ scrollTop: 900, reduceMotion: false });
  app.scrollToSection('preview');
  assert.equal(app.activeSection, 'preview');
});
