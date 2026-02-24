<script lang="ts">
  import type { ParsedOpinion, Footnote } from '../lib/types';
  import { loadPreferences, savePreferences, loadPosition, savePosition } from '../lib/preferences';
  import type { Preferences } from '../lib/preferences';

  interface Props {
    pdfUrl: string;
  }

  let { pdfUrl }: Props = $props();

  let opinion: ParsedOpinion | null = $state(null);
  let error: string | null = $state(null);
  let loading = $state(true);

  let prefs: Preferences = $state(loadPreferences());
  let currentChapterId = $state('');
  let showChapterNav = $state(false);

  // Footnote popover state
  let activeFootnote: { id: number; text: string } | null = $state(null);

  // Chapter progress
  let chapterProgress = $state(0);

  // Segmented progress bar metrics
  interface ChapterMetric { id: string; sizeFraction: number; startPage: number; endPage: number; }
  let chapterMetrics = $state<ChapterMetric[]>([]);

  let pagedChapterIndex = $derived.by(() => {
    const idx = chapterMetrics.findIndex(m => currentPage >= m.startPage && currentPage <= m.endPage);
    return Math.max(0, idx);
  });

  let activeChapterIndex = $derived.by(() => {
    if (prefs.viewMode === 'paged') return pagedChapterIndex;
    if (!opinion) return 0;
    return Math.max(0, opinion.chapters.findIndex(c => c.id === currentChapterId));
  });

  let activeChapterProgress = $derived.by(() => {
    if (prefs.viewMode === 'paged') {
      const m = chapterMetrics[activeChapterIndex];
      return m ? (currentPage - m.startPage) / Math.max(1, m.endPage - m.startPage) : 0;
    }
    return chapterProgress;
  });

  // Section breadcrumb
  let sectionBreadcrumb = $state('');
  let showSectionNav = $state(false);
  let sectionNavPos = $state({ top: 0, left: 0 });

  // Settings pane
  let showSettings = $state(false);

  // Paged mode state
  let currentPage = $state(0);
  let totalPages = $state(0);

  let contentEl: HTMLElement | undefined = $state();
  let wrapperEl: HTMLElement | undefined = $state();

  // Paged mode chevron flash
  let flashPrev = $state(false);
  let flashNext = $state(false);

  // Derived case ID for position storage
  let caseId = $derived(pdfUrl.replace(/[^a-zA-Z0-9]/g, '_'));

  // Load the opinion
  $effect(() => {
    if (!pdfUrl) {
      error = 'No PDF URL provided';
      loading = false;
      return;
    }

    loading = true;
    error = null;

    fetch(`/api/parse?url=${encodeURIComponent(pdfUrl)}&v=3`)
      .then((r) => {
        if (!r.ok) return r.json().then((e: any) => Promise.reject(e.error || 'Parse failed'));
        return r.json();
      })
      .then((data: ParsedOpinion) => {
        opinion = data;
        loading = false;
        if (data.caseTitle) {
          document.title = data.caseTitle + ' — SCOTUS PDF Reader';
        }
        // Track hit (fire-and-forget)
        const pathMatch = pdfUrl.match(/\/(\d{2})pdf\/([\w\-]+\.pdf)/i);
        if (pathMatch) {
          fetch('/api/hit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caseKey: `${pathMatch[1]}/${pathMatch[2]}` }),
          }).catch(() => {});
        }
        // Set initial chapter
        if (data.chapters.length > 0) {
          const saved = loadPosition(caseId);
          if (saved?.chapterId) {
            currentChapterId = saved.chapterId;
            // Restore scroll after render — poll until DOM is ready
            const restorePosition = () => {
              let attempts = 0;
              const maxAttempts = 50; // ~2.5s max
              const poll = () => {
                attempts++;
                const el = document.getElementById(saved.chapterId);
                if (!el && attempts < maxAttempts) {
                  setTimeout(poll, 50);
                  return;
                }
                if (!el) return;
                if (prefs.viewMode === 'paged' && saved.page > 0) {
                  // Wait for pageWidth to be computed
                  if (pageWidth <= 0 && attempts < maxAttempts) {
                    setTimeout(poll, 50);
                    return;
                  }
                  goToPage(saved.page);
                } else if (saved.scrollPercent > 0 && contentEl) {
                  contentEl.scrollTop = saved.scrollPercent * (contentEl.scrollHeight - contentEl.clientHeight);
                } else {
                  el.scrollIntoView();
                }
              };
              requestAnimationFrame(poll);
            };
            restorePosition();
          } else {
            currentChapterId = data.chapters[0].id;
          }
        }
      })
      .catch((err) => {
        error = typeof err === 'string' ? err : 'Failed to load opinion';
        loading = false;
      });
  });

  function jumpToChapter(id: string) {
    currentChapterId = id;
    sectionBreadcrumb = '';
    showChapterNav = false;
    showSectionNav = false;
    const el = document.getElementById(id);
    if (el && prefs.viewMode === 'paged' && pageWidth > 0) {
      // In paged mode, calculate which page the chapter starts on
      const page = Math.round(el.offsetLeft / pageWidth);
      goToPage(page);
    } else if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
    updateHash(id);
  }

  function jumpToSubchapter(chapterId: string, elementId: string) {
    currentChapterId = chapterId;
    showChapterNav = false;
    showSectionNav = false;
    const el = document.getElementById(elementId);
    if (!el) return;
    if (prefs.viewMode === 'paged' && pageWidth > 0) {
      goToPage(Math.floor(el.offsetLeft / pageWidth));
    } else {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function getSubchapters(chapter: { id: string; paragraphs: { text: string }[] }) {
    const result: { level: number; qualified: string; elementId: string }[] = [];
    let h1 = '', h2 = '', h3 = '';
    for (let i = 0; i < chapter.paragraphs.length; i++) {
      const text = chapter.paragraphs[i].text;
      const m = text.match(/^\{\{h([123]):(.+)\}\}$/);
      if (!m) continue;
      const level = parseInt(m[1]);
      const label = m[2];
      if (level === 1) { h1 = label; h2 = ''; h3 = ''; }
      else if (level === 2) { h2 = label; h3 = ''; }
      else { h3 = label; }
      const qualified = [h1, h2, h3].filter(Boolean).join('\u2013');
      result.push({ level, qualified, elementId: `${chapter.id}-sec-${i}` });
    }
    return result;
  }

  function currentChapterSubchapters() {
    if (!opinion) return [];
    const ch = opinion.chapters.find((c) => c.id === currentChapterId);
    return ch ? getSubchapters(ch) : [];
  }

  function updateHash(chapterId: string) {
    history.replaceState(null, '', `#${chapterId}`);
    savePosition(caseId, {
      chapterId,
      scrollPercent: 0,
      page: 0,
    });
  }

  function handleScroll() {
    if (!contentEl || !opinion) return;
    if (prefs.viewMode === 'paged') return;

    // Update current chapter based on scroll position
    let activeChapterEl: HTMLElement | null = null;
    for (const chapter of opinion.chapters) {
      const el = document.getElementById(chapter.id);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= 80) {
          currentChapterId = chapter.id;
          activeChapterEl = el;
        }
      }
    }

    // Compute chapter progress
    if (activeChapterEl) {
      const rect = activeChapterEl.getBoundingClientRect();
      const viewportHeight = contentEl.clientHeight;
      const scrolledPast = -rect.top + 80;
      const chapterHeight = activeChapterEl.offsetHeight;
      chapterProgress = Math.min(1, Math.max(0, scrolledPast / (chapterHeight - viewportHeight)));
    }

    // Track section breadcrumb
    updateBreadcrumb();

    const scrollPercent = contentEl.scrollTop / (contentEl.scrollHeight - contentEl.clientHeight);
    savePosition(caseId, {
      chapterId: currentChapterId,
      scrollPercent,
      page: 0,
    });
  }

  // The page width for paged mode = one full scroll step.
  // We use the outer wrapper's width so columns + gaps tile exactly.
  let pageWidth = $state(0);

  function recalcPages() {
    if (!contentEl || prefs.viewMode !== 'paged') return;
    requestAnimationFrame(() => {
      if (!contentEl) return;
      // In paged mode, padding is 0 so clientWidth == full box width.
      // Each "page" = column-width + column-gap, but the last column has no trailing gap.
      // We set column-gap to 0 and column-width to clientWidth, so each page === clientWidth.
      const w = contentEl.clientWidth;
      pageWidth = w;
      contentEl.style.setProperty('--col-width', `${w}px`);
      requestAnimationFrame(() => {
        if (!contentEl) return;
        totalPages = Math.max(1, Math.round(contentEl.scrollWidth / w));
        if (currentPage >= totalPages) currentPage = totalPages - 1;
        // Re-snap scroll position to current page with new width
        contentEl.scrollTo({ left: currentPage * w, behavior: 'instant' });
      });
    });
  }

  function computeChapterMetrics() {
    if (!opinion || !contentEl) return;
    const metrics: ChapterMetric[] = [];
    if (prefs.viewMode === 'paged' && pageWidth > 0) {
      let docPages = 0;
      for (const ch of opinion.chapters) {
        const el = document.getElementById(ch.id);
        if (!el) continue;
        const startPage = Math.floor(el.offsetLeft / pageWidth);
        const endPage = Math.max(startPage, Math.ceil((el.offsetLeft + el.offsetWidth) / pageWidth) - 1);
        metrics.push({ id: ch.id, sizeFraction: 0, startPage, endPage });
        docPages = Math.max(docPages, endPage + 1);
      }
      for (const m of metrics) m.sizeFraction = (m.endPage - m.startPage + 1) / Math.max(1, docPages);
    } else {
      let totalHeight = 0;
      const els: [string, HTMLElement][] = [];
      for (const ch of opinion.chapters) {
        const el = document.getElementById(ch.id);
        if (!el) continue;
        totalHeight += el.offsetHeight;
        els.push([ch.id, el]);
      }
      for (const [id, el] of els) {
        metrics.push({ id, sizeFraction: el.offsetHeight / Math.max(1, totalHeight), startPage: 0, endPage: 0 });
      }
    }
    chapterMetrics = metrics;
  }

  $effect(() => {
    if (!opinion) return;
    const _mode = prefs.viewMode;
    const _pw = pageWidth;
    requestAnimationFrame(() => computeChapterMetrics());
  });

  function goToPage(n: number) {
    if (!contentEl || !pageWidth) return;
    const clamped = Math.max(0, Math.min(n, totalPages - 1));
    currentPage = clamped;
    contentEl.scrollTo({ left: clamped * pageWidth, behavior: 'instant' });
    // Update current chapter based on which chapter is visible at this page
    if (opinion) {
      for (const chapter of opinion.chapters) {
        const el = document.getElementById(chapter.id);
        if (el) {
          const rect = el.getBoundingClientRect();
          const contentRect = contentEl.getBoundingClientRect();
          // Chapter is visible if its left edge is before viewport right
          // and its right edge is after viewport left
          if (rect.left < contentRect.right && rect.right > contentRect.left) {
            if (currentChapterId !== chapter.id) {
              currentChapterId = chapter.id;
              sectionBreadcrumb = '';
            }
          }
        }
      }
    }
    updateBreadcrumb();
    savePosition(caseId, {
      chapterId: currentChapterId,
      scrollPercent: 0,
      page: currentPage,
    });
  }

  function handleContentClick(e: MouseEvent) {
    // Always dismiss footnote first
    if (activeFootnote) {
      dismissFootnote();
      return;
    }
    if (prefs.viewMode !== 'paged' || !contentEl) return;
    const rect = contentEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;
    if (x < w * 0.25) {
      flashPrev = true;
      setTimeout(() => flashPrev = false, 50);
      goToPage(currentPage - 1);
    } else if (x > w * 0.4) {
      flashNext = true;
      setTimeout(() => flashNext = false, 50);
      goToPage(currentPage + 1);
    }
  }

  // Swipe support for paged mode
  let touchStartX = 0;
  let touchStartY = 0;
  function handleTouchStart(e: TouchEvent) {
    if (prefs.viewMode !== 'paged') return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }
  function handleTouchEnd(e: TouchEvent) {
    if (prefs.viewMode !== 'paged') return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    // Only trigger if horizontal swipe is dominant and > 50px
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) goToPage(currentPage + 1);
      else goToPage(currentPage - 1);
    }
  }

  // Keyboard navigation for paged mode
  function handleKeydown(e: KeyboardEvent) {
    if (prefs.viewMode !== 'paged') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      flashNext = true;
      setTimeout(() => flashNext = false, 50);
      goToPage(currentPage + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      flashPrev = true;
      setTimeout(() => flashPrev = false, 50);
      goToPage(currentPage - 1);
    }
  }

  $effect(() => {
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  // Recalc pages when viewMode, fontSize, or opinion changes
  $effect(() => {
    // Access reactive dependencies
    prefs.viewMode;
    prefs.fontSize;
    opinion;
    if (prefs.viewMode === 'paged') {
      // Small delay to let layout settle
      setTimeout(recalcPages, 100);
    }
  });

  // Resize observer to keep paged mode in sync with container size changes
  $effect(() => {
    if (!contentEl || prefs.viewMode !== 'paged') return;
    const ro = new ResizeObserver(() => recalcPages());
    ro.observe(contentEl);
    return () => ro.disconnect();
  });

  /** Find the first visible content element in the current viewport */
  function findAnchorElement(): HTMLElement | null {
    if (!contentEl) return null;
    const candidates = contentEl.querySelectorAll('.paragraph, .section-heading, .chapter-heading');
    const contentRect = contentEl.getBoundingClientRect();

    if (prefs.viewMode === 'paged') {
      // In paged mode, find first element whose left edge is within the current page
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.left >= contentRect.left && rect.left < contentRect.right) {
          return el as HTMLElement;
        }
      }
    } else {
      // In scroll mode, find the first element at or below the toolbar (~80px)
      let lastAbove: HTMLElement | null = null;
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.top >= 80) return el as HTMLElement;
        lastAbove = el as HTMLElement;
      }
      return lastAbove;
    }
    return null;
  }

  function setViewMode(mode: 'scroll' | 'paged') {
    const anchor = findAnchorElement();
    prefs.viewMode = mode;
    savePreferences(prefs);

    if (mode === 'paged') {
      // Wait for paged layout to settle, then navigate to anchor's page
      const pollForLayout = () => {
        let attempts = 0;
        const poll = () => {
          attempts++;
          if (pageWidth > 0 && anchor) {
            const page = Math.floor(anchor.offsetLeft / pageWidth);
            goToPage(page);
          } else if (attempts < 30) {
            setTimeout(poll, 50);
          }
        };
        requestAnimationFrame(poll);
      };
      pollForLayout();
    } else {
      // Switching to scroll mode — scroll anchor into view after layout
      if (anchor) {
        requestAnimationFrame(() => {
          anchor.scrollIntoView({ block: 'start' });
        });
      }
    }
  }

  function updateBreadcrumb() {
    if (!contentEl) return;
    // Scope heading scan to the current chapter only
    const chapterEl = document.getElementById(currentChapterId);
    if (!chapterEl) { sectionBreadcrumb = ''; return; }
    const headings = chapterEl.querySelectorAll('.section-heading');
    let h1 = '', h2 = '', h3 = '';
    const isPaged = prefs.viewMode === 'paged';
    const viewportRight = contentEl.getBoundingClientRect().right;
    for (const el of headings) {
      const rect = el.getBoundingClientRect();
      // In scroll mode: heading has scrolled past the top toolbar
      // In paged mode: heading is on a previous or current page (left edge before viewport right)
      const isPast = isPaged ? rect.left < viewportRight : rect.top <= 80;
      if (!isPast) break;
      if (el.classList.contains('h1')) {
        h1 = el.textContent?.trim() ?? '';
        h2 = '';
        h3 = '';
      } else if (el.classList.contains('h2')) {
        h2 = el.textContent?.trim() ?? '';
        h3 = '';
      } else if (el.classList.contains('h3')) {
        h3 = el.textContent?.trim() ?? '';
      }
    }
    const parts = [h1, h2, h3].filter(Boolean);
    sectionBreadcrumb = parts.join('\u2013');
  }

  function updateFontSize(e: Event) {
    const target = e.target as HTMLInputElement;
    prefs.fontSize = parseInt(target.value);
    savePreferences(prefs);
  }

  function currentChapterTitle(): string {
    if (!opinion) return '';
    const ch = opinion.chapters.find((c) => c.id === currentChapterId);
    return ch ? ch.title : '';
  }

  /** Split boilerplate text on underscore separator runs for line-break rendering */
  function splitBoilerplate(text: string): string[] {
    return text.split(/\s*_{5,}\s*/).filter(Boolean);
  }

  /** Split paragraph text into segments of plain text and footnote references */
  function parseSegments(text: string): { type: 'text' | 'fn'; value: string }[] {
    const segments: { type: 'text' | 'fn'; value: string }[] = [];
    const regex = /\{\{fn:(\d+)\}\}/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
      }
      segments.push({ type: 'fn', value: match[1] });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
      segments.push({ type: 'text', value: text.slice(lastIndex) });
    }
    return segments;
  }

  function showFootnote(fnId: number, chapterFootnotes: Footnote[], event: MouseEvent) {
    event.stopPropagation();
    const fn = chapterFootnotes.find((f) => f.id === fnId);
    if (!fn) return;

    activeFootnote = { id: fn.id, text: fn.text };
  }

  function dismissFootnote() {
    activeFootnote = null;
  }

  function scrollToRef(chapterId: string, fnId: number) {
    const el = document.getElementById(`${chapterId}-ref-${fnId}`);
    if (!el) return;
    if (prefs.viewMode === 'paged' && pageWidth > 0) {
      const page = Math.floor(el.offsetLeft / pageWidth);
      goToPage(page);
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
</script>

{#if loading}
  <div class="loading-screen">
    <div class="spinner"></div>
    <p>Loading opinion...</p>
  </div>
{:else if error}
  <div class="error-screen">
    <p>{error}</p>
    <a href="/">Back to home</a>
  </div>
{:else if opinion}
  <!-- Toolbar -->
  <header class="toolbar">
    <a href="/" class="back-link" aria-label="Home">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5">
        <!-- pediment -->
        <polygon points="12,2 3,8 21,8" fill="var(--accent)" stroke="var(--accent)" stroke-linejoin="round"/>
        <!-- entablature -->
        <rect x="3" y="8" width="18" height="2" fill="var(--accent)"/>
        <!-- columns -->
        <rect x="5" y="10" width="2" height="9" fill="var(--accent)"/>
        <rect x="11" y="10" width="2" height="9" fill="var(--accent)"/>
        <rect x="17" y="10" width="2" height="9" fill="var(--accent)"/>
        <!-- base -->
        <rect x="2" y="19" width="20" height="2" rx="0.5" fill="var(--accent)"/>
      </svg>
    </a>
    <div class="toolbar-info">
      <button class="case-name-btn" onclick={() => contentEl?.scrollTo({ top: 0, behavior: 'smooth' })}>
        {opinion.caseTitle}
      </button>
      <div class="toolbar-row">
        <button class="chapter-btn" onclick={() => { showChapterNav = !showChapterNav; showSectionNav = false; }}>
          {currentChapterTitle()}
          <span class="chevron">{showChapterNav ? '\u25B2' : '\u25BC'}</span>
        </button>
        {#if sectionBreadcrumb}
          {@const subs = currentChapterSubchapters()}
          {#if subs.length > 0}
            <button class="section-breadcrumb-btn" onclick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              sectionNavPos = { top: rect.bottom + 4, left: rect.left };
              showSectionNav = !showSectionNav;
              showChapterNav = false;
            }}>
              {sectionBreadcrumb}
              <span class="chevron">{showSectionNav ? '\u25B2' : '\u25BC'}</span>
            </button>
          {:else}
            <span class="section-breadcrumb">{sectionBreadcrumb}</span>
          {/if}
        {/if}
      </div>
    </div>
    <div class="toolbar-controls">
      <button class="settings-btn" onclick={() => showSettings = !showSettings} aria-label="Settings">
        <span class="settings-icon">Aa</span>
      </button>
    </div>
  </header>

  <!-- Settings pane -->
  {#if showSettings}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="settings-overlay" onclick={() => showSettings = false}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="settings-pane" onclick={(e) => e.stopPropagation()}>
        <label class="settings-label">
          Text size
          <input
            type="range"
            min="14"
            max="28"
            value={prefs.fontSize}
            oninput={updateFontSize}
            class="font-slider"
            aria-label="Text size"
          />
        </label>
        <label class="settings-label">
          Reading mode
          <div class="mode-toggle">
            <button
              class="mode-btn"
              class:active={prefs.viewMode === 'scroll'}
              onclick={() => setViewMode('scroll')}
            >Scroll</button>
            <button
              class="mode-btn"
              class:active={prefs.viewMode === 'paged'}
              onclick={() => setViewMode('paged')}
            >Paged</button>
          </div>
        </label>
      </div>
    </div>
  {/if}

  <!-- Chapter navigation dropdown -->
  {#if showChapterNav}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="chapter-overlay" onclick={() => showChapterNav = false}>
      <nav class="chapter-nav">
        {#each opinion.chapters as chapter}
          <button
            class="chapter-item"
            class:active={chapter.id === currentChapterId}
            onclick={() => jumpToChapter(chapter.id)}
          >
            <span class="chapter-title">{chapter.title}</span>
            {#if chapter.author}
              <span class="chapter-author">{chapter.author}</span>
            {/if}
          </button>
        {/each}
      </nav>
    </div>
  {/if}

  {#if showSectionNav}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="section-nav-backdrop" onclick={() => showSectionNav = false}></div>
    <nav class="section-nav" style="top: {sectionNavPos.top}px; left: {sectionNavPos.left}px">
      {#each currentChapterSubchapters() as sub}
        <button
          class="subchapter-item"
          class:subchapter-h2={sub.level === 2}
          class:subchapter-h3={sub.level === 3}
          class:active={sub.qualified === sectionBreadcrumb}
          onclick={() => jumpToSubchapter(currentChapterId, sub.elementId)}
        >{sub.qualified}</button>
      {/each}
    </nav>
  {/if}

  <!-- Content -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="content-wrapper" class:paged={prefs.viewMode === 'paged'} class:flash-prev={flashPrev} class:flash-next={flashNext} bind:this={wrapperEl}>
  <div
    class="content"
    class:paged={prefs.viewMode === 'paged'}
    style="font-size: {prefs.fontSize}px"
    bind:this={contentEl}
    onscroll={handleScroll}
    onclick={handleContentClick}
    ontouchstart={handleTouchStart}
    ontouchend={handleTouchEnd}
  >
    <div class="case-header">
      <h1>{opinion.caseTitle}</h1>
      {#if opinion.docketNumber}
        <p class="docket">No. {opinion.docketNumber}</p>
      {/if}
      {#if opinion.decidedDate}
        <p class="decided">Decided {opinion.decidedDate}</p>
      {/if}
    </div>

    {#each opinion.chapters as chapter}
      <section id={chapter.id} class="chapter">
        <h2 class="chapter-heading">{chapter.title}</h2>

        {#each chapter.paragraphs as para, pi}
          {#if para.text.startsWith('{{h1:')}
            <div class="section-heading h1" id="{chapter.id}-sec-{pi}">{para.text.slice(5, -2)}</div>
          {:else if para.text.startsWith('{{h2:')}
            <div class="section-heading h2" id="{chapter.id}-sec-{pi}">{para.text.slice(5, -2)}</div>
          {:else if para.text.startsWith('{{h3:')}
            <div class="section-heading h3" id="{chapter.id}-sec-{pi}">{para.text.slice(5, -2)}</div>
          {:else if para.text.startsWith('{{bp:') || para.text.startsWith('{{bpj:')}
            {#if pi === 0 || (!chapter.paragraphs[pi - 1]?.text.startsWith('{{bp:') && !chapter.paragraphs[pi - 1]?.text.startsWith('{{bpj:'))}
              <div class="chapter-boilerplate">
                {#each chapter.paragraphs.slice(pi) as bp}
                  {#if bp.text.startsWith('{{bpj:')}
                    <p class="boilerplate-justice">{bp.text.slice(6, -2)}</p>
                  {:else if bp.text.startsWith('{{bp:')}
                    <p>{#each splitBoilerplate(bp.text.slice(5, -2)) as part, si}{#if si > 0}<br/>{/if}{part}{/each}</p>
                  {/if}
                {/each}
              </div>
            {/if}
          {:else}
            <p class="paragraph">
              {#each parseSegments(para.text) as seg}
                {#if seg.type === 'fn'}
                  <button
                    class="fn-ref"
                    id="{chapter.id}-ref-{seg.value}"
                    onclick={(e) => showFootnote(parseInt(seg.value), chapter.footnotes, e)}
                  >{seg.value}</button>
                {:else}
                  {seg.value}
                {/if}
              {/each}
            </p>
          {/if}
        {/each}

        {#if chapter.footnotes && chapter.footnotes.length > 0}
          <div class="chapter-footnotes">
            {#each chapter.footnotes as fn}
              <div class="chapter-footnote" id="{chapter.id}-fn-{fn.id}">
                <button class="fn-back" onclick={() => scrollToRef(chapter.id, fn.id)}>{fn.id}</button>
                <span class="fn-text">{fn.text}</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>

  <!-- Footnote popover (fixed position, outside column layout) -->
  {#if activeFootnote}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="footnote-popover"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="footnote-header">
        <span class="footnote-num">{activeFootnote.id}</span>
        <button class="footnote-close" onclick={dismissFootnote}>&times;</button>
      </div>
      <p>{activeFootnote.text}</p>
    </div>
  {/if}
  </div>

  <!-- Segmented progress bar -->
  {#if chapterMetrics.length > 0}
    <div class="segmented-progress">
      {#each chapterMetrics as cm, i}
        <div class="progress-segment" style="flex: {cm.sizeFraction}">
          <div
            class="progress-fill"
            class:past={i < activeChapterIndex}
            class:active={i === activeChapterIndex}
            style="width: {i < activeChapterIndex ? 100 : i === activeChapterIndex ? activeChapterProgress * 100 : 0}%"
          ></div>
        </div>
      {/each}
    </div>
  {/if}

{/if}

<style>
  .loading-screen, .error-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 1rem;
    color: var(--text-secondary);
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 10;
    flex-shrink: 0;
  }

  .back-link {
    display: flex;
    align-items: center;
    padding: 0.25rem;
    text-decoration: none;
    flex-shrink: 0;
  }

  .chapter-btn {
    text-align: left;
    background: none;
    border: none;
    font-family: var(--font-ui);
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .chapter-btn:hover {
    background: var(--bg);
  }

  .chevron {
    font-size: 0.65rem;
    flex-shrink: 0;
  }

  .section-breadcrumb {
    font-size: 0.75rem;
    color: var(--text-secondary);
    font-family: var(--font-ui);
    white-space: nowrap;
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .section-breadcrumb-btn {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    font-family: var(--font-ui);
    white-space: nowrap;
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .section-breadcrumb-btn:hover {
    color: var(--text);
  }

  .toolbar-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .font-slider {
    width: 80px;
    accent-color: var(--accent);
  }

  .toolbar-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .case-name-btn {
    background: none;
    border: none;
    font-family: var(--font-ui);
    font-size: 0.7rem;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
    max-width: 100%;
  }

  .case-name-btn:hover {
    color: var(--text);
  }

  .toolbar-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .chapter-overlay {
    position: fixed;
    inset: 0;
    top: 49px;
    z-index: 20;
    background: rgba(0, 0, 0, 0.3);
  }

  .chapter-nav {
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    max-height: 60vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .chapter-item {
    display: flex;
    flex-direction: column;
    padding: 0.75rem 1rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    font-family: var(--font-ui);
    color: var(--text);
    border-bottom: 1px solid var(--border);
  }

  .chapter-item:hover {
    background: var(--bg);
  }

  .chapter-item.active {
    background: var(--bg);
    border-left: 3px solid var(--accent);
  }

  .chapter-title {
    font-weight: 600;
    font-size: 0.9rem;
  }

  .chapter-author {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .section-nav-backdrop {
    position: fixed;
    inset: 0;
    z-index: 24;
  }

  .section-nav {
    position: fixed;
    z-index: 25;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    max-height: 50vh;
    overflow-y: auto;
    min-width: 5rem;
    display: flex;
    flex-direction: column;
  }

  .subchapter-item {
    display: block;
    padding: 0.45rem 1rem 0.45rem 0.75rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: 0.85rem;
    color: var(--text);
    border-bottom: 1px solid var(--border);
    width: 100%;
    white-space: nowrap;
  }

  .subchapter-item:last-child {
    border-bottom: none;
  }

  .subchapter-item:hover, .subchapter-item.active {
    background: var(--bg);
  }

  .subchapter-item.subchapter-h2 {
    padding-left: 1.75rem;
    color: var(--text-secondary);
    font-size: 0.8rem;
  }

  .subchapter-item.subchapter-h3 {
    padding-left: 2.75rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem 1rem;
    max-width: 680px;
    margin: 0 auto;
    width: 100%;
    font-family: var(--font-body);
    line-height: 1.7;
    position: relative;
  }

  .content.paged {
    overflow: hidden;
    padding: 1.5rem 0 2rem;
    max-width: none;
    min-height: 0;
    column-fill: auto;
    column-gap: 0;
    column-width: var(--col-width, 100vw);
  }

  .content-wrapper {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .content-wrapper.paged::before,
  .content-wrapper.paged::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 3px;
    pointer-events: none;
    z-index: 1;
    opacity: 0;
    background: var(--text);
    transition: opacity 0.05s ease-out;
  }

  .content-wrapper.paged::before {
    left: 0;
  }

  .content-wrapper.paged::after {
    right: 0;
  }

  .content-wrapper.flash-prev::before {
    opacity: 0.2;
    transition: none;
  }

  .content-wrapper.flash-next::after {
    opacity: 0.2;
    transition: none;
  }

  .content.paged .chapter,
  .content.paged .case-header {
    padding-left: 1rem;
    padding-right: 1rem;
    max-width: 680px;
    margin-left: auto;
    margin-right: auto;
  }

  .content.paged .chapter:not(:first-of-type) {
    break-before: column;
  }

  .case-header {
    text-align: center;
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .case-header h1 {
    font-family: var(--font-body);
    font-size: 1.4em;
    line-height: 1.3;
    margin-bottom: 0.5rem;
  }

  .docket, .decided {
    color: var(--text-secondary);
    font-size: 0.85em;
  }

  .chapter {
    margin-bottom: 2rem;
  }

  .chapter-heading {
    font-family: var(--font-body);
    font-size: 1.1em;
    color: var(--accent);
    margin-bottom: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }

  .section-heading {
    text-align: center;
    font-weight: 700;
    font-family: var(--font-body);
    margin: 1.5em 0 0.5em;
  }

  .section-heading.h1 {
    font-size: 1.15em;
  }

  .section-heading.h2 {
    font-size: 1.05em;
  }

  .section-heading.h3 {
    font-size: 1em;
  }

  .chapter-boilerplate {
    text-align: center;
    font-size: 0.8em;
    color: var(--text-secondary);
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
    line-height: 1.5;
  }

  .chapter-boilerplate p {
    margin: 0.75em 0;
  }

  .chapter-boilerplate .boilerplate-justice {
    margin-top: 1.25em;
    padding-top: 0.75em;
    border-top: 1px solid var(--border);
    font-size: 1.15em;
    color: var(--accent);
    font-weight: 600;
    font-style: italic;
  }

  .paragraph {
    margin-bottom: 1em;
    text-align: justify;
    text-indent: 2em;
  }

  .paragraph:first-of-type {
    text-indent: 0;
  }

  .fn-ref {
    display: inline;
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.75em;
    font-weight: 700;
    cursor: pointer;
    padding: 0 0.15em;
    vertical-align: baseline;
    position: relative;
    top: -0.4em;
    line-height: 1;
    font-family: inherit;
  }

  .fn-ref:hover {
    text-decoration: underline;
  }

  .chapter-footnotes {
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }

  .chapter-footnote {
    font-size: 0.85em;
    line-height: 1.5;
    margin-bottom: 0.75em;
    text-indent: 0;
    color: var(--text-secondary);
  }

  .fn-back {
    display: inline;
    background: none;
    border: none;
    font-weight: 700;
    color: var(--accent);
    margin-right: 0.4em;
    cursor: pointer;
    font-size: inherit;
    font-family: inherit;
    padding: 0;
  }

  .fn-back:hover {
    text-decoration: underline;
  }

  .footnote-popover {
    position: fixed;
    z-index: 30;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--bg-surface);
    border-top: 2px solid var(--accent);
    padding: 0.75rem 1rem;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.1);
    font-size: 0.9em;
    line-height: 1.6;
    font-family: var(--font-body);
    max-width: 680px;
    margin: 0 auto;
    max-height: 50vh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .footnote-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .footnote-num {
    font-weight: 700;
    color: var(--accent);
  }

  .footnote-close {
    background: none;
    border: none;
    font-size: 1.2rem;
    cursor: pointer;
    color: var(--text-secondary);
    padding: 0 0.25rem;
    line-height: 1;
  }

  .footnote-close:hover {
    color: var(--text);
  }

  .footnote-popover p {
    margin: 0;
    color: var(--text-secondary);
  }

  .settings-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0.15rem 0.4rem;
    display: flex;
    align-items: center;
  }

  .settings-btn:hover {
    color: var(--text);
    background: var(--bg);
  }

  .settings-icon {
    font-family: var(--font-body);
    font-size: 0.85rem;
    font-weight: 600;
    line-height: 1;
  }

  .settings-overlay {
    position: fixed;
    inset: 0;
    top: 49px;
    z-index: 20;
    background: rgba(0, 0, 0, 0.3);
  }

  .settings-pane {
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .settings-label {
    font-family: var(--font-ui);
    font-size: 0.85rem;
    color: var(--text-secondary);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .mode-toggle {
    display: flex;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .mode-btn {
    flex: 1;
    padding: 0.4rem 0.75rem;
    border: none;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 0.85rem;
    cursor: pointer;
  }

  .mode-btn.active {
    background: var(--accent);
    color: #fff;
  }

  .segmented-progress {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    display: flex;
    gap: 2px;
    z-index: 10;
  }

  .progress-segment {
    height: 100%;
    background: var(--border);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    width: 0%;
    transition: width 0.1s;
  }

  .progress-fill.active {
    background: var(--accent);
  }

  .progress-fill.past {
    background: color-mix(in srgb, var(--accent) 45%, transparent);
  }
</style>
