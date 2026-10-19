/**
 * 图提取 ImageGrab —— 官网交互脚本 main.js
 * 功能：
 *   1. 滚动时导航栏吸顶（加毛玻璃 + 阴影）；
 *   2. 滚动监听，高亮当前区块对应的导航项；
 *   3. 移动端汉堡菜单展开 / 收起；
 *   4. IntersectionObserver 实现元素进入视口时的淡入上移动画；
 *   5. 页脚年份自动更新。
 */

'use strict';

(function () {
  const navbar = document.getElementById('navbar');
  const navLinks = document.getElementById('nav-links');
  const navToggle = document.getElementById('nav-toggle');
  const links = Array.from(navLinks ? navLinks.querySelectorAll('a[href^="#"]') : []);
  const sections = links
    .map((a) => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);

  // ===== 1. 滚动吸顶 =====
  function onScrollNavbar() {
    if (!navbar) return;
    navbar.classList.toggle('is-stuck', window.scrollY > 12);
  }

  // ===== 2. 导航高亮 =====
  function highlightNav() {
    if (!sections.length) return;
    const offset = window.scrollY + 96; // 导航栏高度补偿
    let current = sections[0];

    sections.forEach((sec) => {
      if (sec.offsetTop <= offset) current = sec;
    });

    // 滚到页面底部时，高亮最后一个区块
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 4) {
      current = sections[sections.length - 1];
    }

    links.forEach((a) => {
      a.classList.toggle('is-active', a.getAttribute('href') === '#' + current.id);
    });
  }

  // 用 rAF 节流，避免滚动事件里做重排
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      onScrollNavbar();
      highlightNav();
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  // ===== 3. 移动端菜单 =====
  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      const open = navLinks.classList.toggle('is-open');
      navToggle.classList.toggle('is-open', open);
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? '收起菜单' : '展开菜单');
    });

    // 点击菜单项后自动收起
    navLinks.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        navLinks.classList.remove('is-open');
        navToggle.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
        navToggle.setAttribute('aria-label', '展开菜单');
      });
    });

    // 点击页面其他区域也收起
    document.addEventListener('click', (e) => {
      if (!navLinks.classList.contains('is-open')) return;
      if (navLinks.contains(e.target) || navToggle.contains(e.target)) return;
      navLinks.classList.remove('is-open');
      navToggle.classList.remove('is-open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  }

  // ===== 4. 进入视口淡入上移 =====
  const revealEls = Array.from(document.querySelectorAll('.reveal'));

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          // 同一批元素做一点错位，看起来更自然
          const idx = revealEls.indexOf(entry.target);
          const delay = Math.min((idx % 6) * 70, 350);
          setTimeout(() => entry.target.classList.add('is-visible'), delay);
          io.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    revealEls.forEach((elm) => io.observe(elm));
  } else {
    // 老浏览器直接显示
    revealEls.forEach((elm) => elm.classList.add('is-visible'));
  }

  // ===== 5. 页脚年份 =====
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ===== 初始化 =====
  onScrollNavbar();
  highlightNav();
})();
