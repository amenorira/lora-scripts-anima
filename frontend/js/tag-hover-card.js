/* ================================================================
   tag-hover-card.js — 标签悬停说明卡

   卡片只有一个实例（DOM 写在 index.html 里，由 Alpine 渲染），
   所有事件用委托挂在 document 上：标签 chip 由 x-for 反复重建，
   逐个绑监听会随渲染泄漏。

   鼠标 250ms 后显示、离开 120ms 后关闭，并且允许鼠标从 chip 移进卡片
   ——否则卡片里的"复制/查找"根本点不到。
   ================================================================ */
(function (global) {
  'use strict';

  var CHIP_SELECTOR = '.te-editor-tag[data-tag]';
  var attached = false;

  function chipOf(node) {
    if (!node || typeof node.closest !== 'function') return null;
    return node.closest(CHIP_SELECTOR);
  }

  function tagOf(chip) {
    return chip ? (chip.getAttribute('data-tag') || '') : '';
  }

  function attach(ctx) {
    if (attached) return;
    attached = true;

    document.addEventListener('mouseover', function (event) {
      var chip = chipOf(event.target);
      if (!chip || chip.contains(event.relatedTarget)) return;
      ctx.tagDictionaryHoverEnter(tagOf(chip), chip);
    }, true);

    document.addEventListener('mouseout', function (event) {
      var chip = chipOf(event.target);
      if (!chip || chip.contains(event.relatedTarget)) return;
      ctx.tagDictionaryHoverLeave();
    }, true);

    // 键盘：chip 拿到焦点即显示，失去焦点即关闭
    document.addEventListener('focusin', function (event) {
      var chip = chipOf(event.target);
      if (chip) ctx.tagDictionaryHoverEnter(tagOf(chip), chip);
    });
    document.addEventListener('focusout', function (event) {
      var chip = chipOf(event.target);
      if (chip) ctx.tagDictionaryHoverLeave();
    });

    // 触摸：没有 hover，点一下标签看说明
    document.addEventListener('pointerup', function (event) {
      if (!event.pointerType || event.pointerType === 'mouse') return;
      var chip = chipOf(event.target);
      if (!chip) return;
      var tag = tagOf(chip);
      var hover = ctx.tagDictionaryHover;
      if (hover && hover.tag === tag) ctx.tagDictionaryCloseHover();
      else {
        ctx.tagDictionaryCancelHoverTimers();
        ctx._tdShowHover(tag, chip);
      }
    });

    // 滚动时标签已经不在原位，直接收起
    window.addEventListener('scroll', function () {
      if (ctx.tagDictionaryHover) ctx.tagDictionaryCloseHover();
    }, true);
  }

  global.tagHoverCard = { attach: attach };
})(window);
