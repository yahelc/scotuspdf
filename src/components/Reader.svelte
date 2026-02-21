<script lang="ts">
  import type { ParsedOpinion, Chapter, Footnote } from '../lib/types';
  import { loadPreferences, savePreferences, loadPosition, savePosition } from '../lib/preferences';
  import type { Preferences, ReadingPosition } from '../lib/preferences';

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
  let activeFootnote: Footnote | null = $state(null);
  let footnotePosX = $state(0);
  let footnotePosY = $state(0);

  let contentEl: HTMLElement | undefined = $state();

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

    fetch(`/api/parse?url=${encodeURIComponent(pdfUrl)}`)
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
        // Set initial chapter
        if (data.chapters.length > 0) {
          const saved = loadPosition(caseId);
          if (saved?.chapterId) {
            currentChapterId = saved.chapterId;
            // Restore scroll after render
            requestAnimationFrame(() => {
              const el = document.getElementById(saved.chapterId);
              if (el) el.scrollIntoView();
            });
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
    showChapterNav = false;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
    updateHash(id);
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

    // Update current chapter based on scroll position
    for (const chapter of opinion.chapters) {
      const el = document.getElementById(chapter.id);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= 80) {
          currentChapterId = chapter.id;
        }
      }
    }

    const scrollPercent = contentEl.scrollTop / (contentEl.scrollHeight - contentEl.clientHeight);
    savePosition(caseId, {
      chapterId: currentChapterId,
      scrollPercent,
      page: 0,
    });
  }

  function showFootnote(fn: Footnote, event: MouseEvent) {
    if (activeFootnote?.id === fn.id) {
      activeFootnote = null;
      return;
    }
    activeFootnote = fn;
    const target = event.target as HTMLElement;
    const rect = target.getBoundingClientRect();
    footnotePosX = rect.left;
    footnotePosY = rect.bottom + 8;
  }

  function dismissFootnote() {
    activeFootnote = null;
  }

  function updateFontSize(e: Event) {
    const target = e.target as HTMLInputElement;
    prefs.fontSize = parseInt(target.value);
    savePreferences(prefs);
  }

  function toggleViewMode() {
    prefs.viewMode = prefs.viewMode === 'scroll' ? 'paged' : 'scroll';
    savePreferences(prefs);
  }

  function currentChapterTitle(): string {
    if (!opinion) return '';
    const ch = opinion.chapters.find((c) => c.id === currentChapterId);
    return ch ? ch.title : '';
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
    <a href="/" class="back-link" aria-label="Home">&#8592;</a>
    <button class="chapter-btn" onclick={() => showChapterNav = !showChapterNav}>
      {currentChapterTitle()}
      <span class="chevron">{showChapterNav ? '\u25B2' : '\u25BC'}</span>
    </button>
    <div class="toolbar-controls">
      <input
        type="range"
        min="14"
        max="28"
        value={prefs.fontSize}
        oninput={updateFontSize}
        class="font-slider"
        aria-label="Text size"
      />
    </div>
  </header>

  <!-- Chapter navigation dropdown -->
  {#if showChapterNav}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="chapter-overlay" onclick={dismissFootnote}>
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

  <!-- Content -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="content"
    class:paged={prefs.viewMode === 'paged'}
    style="font-size: {prefs.fontSize}px"
    bind:this={contentEl}
    onscroll={handleScroll}
    onclick={dismissFootnote}
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

        {#each chapter.paragraphs as para}
          <p class="paragraph">
            {para.text}
            {#each para.footnotes as fn}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <sup
                class="footnote-ref"
                onclick={(e) => { e.stopPropagation(); showFootnote(fn, e); }}
              >{fn.id}</sup>
            {/each}
          </p>
        {/each}
      </section>
    {/each}
  </div>

  <!-- Footnote popover -->
  {#if activeFootnote}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="footnote-popover"
      style="left: {Math.min(footnotePosX, window.innerWidth - 320)}px; top: {footnotePosY}px"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="footnote-header">
        <span class="footnote-num">{activeFootnote.id}</span>
        <button class="footnote-close" onclick={dismissFootnote}>&times;</button>
      </div>
      <p>{activeFootnote.text}</p>
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
    font-size: 1.25rem;
    padding: 0.25rem 0.5rem;
    text-decoration: none;
  }

  .chapter-btn {
    flex: 1;
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

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem 1rem;
    max-width: 680px;
    margin: 0 auto;
    width: 100%;
    font-family: var(--font-body);
    line-height: 1.7;
  }

  .content.paged {
    overflow: hidden;
    columns: 1;
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

  .paragraph {
    margin-bottom: 1em;
    text-align: justify;
    text-indent: 2em;
  }

  .paragraph:first-of-type {
    text-indent: 0;
  }

  .footnote-ref {
    color: var(--accent);
    cursor: pointer;
    font-size: 0.75em;
    padding: 0 2px;
    font-weight: 600;
  }

  .footnote-ref:hover {
    text-decoration: underline;
  }

  .footnote-popover {
    position: fixed;
    z-index: 30;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    max-width: 320px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    font-family: var(--font-body);
    font-size: 0.85rem;
    line-height: 1.5;
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
    font-size: 0.8rem;
  }

  .footnote-close {
    background: none;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-secondary);
    padding: 0 0.25rem;
  }
</style>
