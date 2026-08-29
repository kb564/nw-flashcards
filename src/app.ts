import type { Grade } from "ts-fsrs";
import {
  decryptPayload,
  encryptPayload,
  importPassphrase,
  MAX_IMPORT_BYTES,
  parseEnvelopeText,
  validatePassphrase,
} from "./crypto";
import { deleteVaultEnvelope, loadVaultEnvelope, saveVaultEnvelope } from "./storage";
import { lockedImportModes } from "./import-policy";
import {
  applyRating,
  buildStudyQueue,
  filterCards,
  formatInterval,
  getStudyCounts,
  mergeDeck,
  previewIntervals,
  RATINGS,
  RATING_LABELS,
} from "./study";
import {
  CARD_KINDS,
  IMPORTANCE_LEVELS,
  type CardFilters,
  type EncryptedEnvelope,
  type StudyCard,
  type VaultPayload,
} from "./types";
import { normalizeDeckPayload, normalizeVaultPayload } from "./validation";

type Route = "home" | "study" | "browse" | "settings";
type ImportMode = "deck" | "backup";

function requireRoot(): HTMLDivElement {
  const node = document.querySelector<HTMLDivElement>("#app");
  if (!node) throw new Error("アプリの表示領域が見つかりません。");
  return node;
}

const root = requireRoot();

let storedEnvelope: EncryptedEnvelope | null = null;
let vault: VaultPayload | null = null;
let sessionMaterial: CryptoKey | null = null;
let route: Route = "home";
let studyQueue: StudyCard[] = [];
let studyIndex = 0;
let answerVisible = false;
let busy = false;
let browseFocusId: string | null = null;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className = "button"): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  return node;
}

function announce(message: string, tone: "info" | "error" | "success" = "info"): HTMLElement {
  const box = element("div", `notice notice-${tone}`, message);
  box.setAttribute("role", tone === "error" ? "alert" : "status");
  return box;
}

function setBusy(value: boolean): void {
  busy = value;
  root.toggleAttribute("aria-busy", value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "処理を完了できませんでした。";
}

function lockApp(message?: string): void {
  vault = null;
  sessionMaterial = null;
  studyQueue = [];
  studyIndex = 0;
  answerVisible = false;
  renderLocked(message);
}

function renderBrand(): HTMLElement {
  const brand = element("div", "brand");
  const mark = element("div", "brand-mark", "NW");
  mark.setAttribute("aria-hidden", "true");
  const copy = element("div");
  copy.append(element("p", "eyebrow", "NETWORK SPECIALIST"), element("h1", "brand-title", "ネスペ暗記カード"));
  brand.append(mark, copy);
  return brand;
}

function renderLocked(message?: string): void {
  root.replaceChildren();
  const shell = element("main", "lock-shell");
  shell.append(renderBrand());
  const panel = element("section", "lock-panel");
  if (message) panel.append(announce(message));
  if (storedEnvelope) {
    panel.append(
      element("p", "kicker", "端末内の暗号化保管庫"),
      element("h2", "lock-title", "学習を再開"),
      element("p", "muted", "パスフレーズはこの端末にも送信先にも保存されません。"),
    );
    const form = element("form", "stack");
    const input = passwordInput("パスフレーズ", "current-password");
    const submit = button("ロックを解除", "button button-primary button-wide");
    submit.type = "submit";
    form.append(input.label, input.input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void unlockStoredVault(input.input, panel);
    });
    panel.append(form, separator("または"));
  } else {
    panel.append(
      element("p", "kicker", "PRIVATE • OFFLINE FIRST"),
      element("h2", "lock-title", "カードを端末へ取り込む"),
      element(
        "p",
        "muted",
        "カード本文はGitHubを通りません。Macで作成した暗号化ファイルを、Filesから直接読み込みます。",
      ),
    );
  }
  if (storedEnvelope) {
    panel.append(element("p", "field-help", "デッキを更新するには、先にロックを解除して設定画面から取り込んでください。復習履歴を安全に引き継げます。"));
  }
  for (const mode of lockedImportModes(storedEnvelope !== null)) {
    panel.append(importLauncher(mode === "deck" ? "暗号化デッキを取り込む" : "バックアップから復元", mode));
  }
  const privacy = element("div", "privacy-note");
  privacy.append(
    element("span", "privacy-dot"),
    element("p", "", "外部通信・広告・解析なし。復習データは暗号化して端末内だけに保存します。"),
  );
  shell.append(panel, privacy);
  root.append(shell);
}

function passwordInput(labelText: string, autocomplete: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const id = `password-${crypto.randomUUID()}`;
  const label = element("label", "field-label", labelText);
  label.htmlFor = id;
  const input = element("input", "field-input");
  input.id = id;
  input.type = "password";
  input.setAttribute("autocomplete", autocomplete);
  input.spellcheck = false;
  input.required = true;
  input.maxLength = 256;
  return { label, input };
}

function separator(text: string): HTMLElement {
  const line = element("div", "separator");
  line.append(element("span"), element("small", "", text), element("span"));
  return line;
}

function importLauncher(label: string, mode: ImportMode): HTMLButtonElement {
  const launch = button(label, "button button-secondary button-wide");
  launch.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    // iOS Filesは独自拡張子をacceptで絞ると選択不能にすることがある。
    // ファイル種別は選択後にサイズ、拡張用途、厳格スキーマ、AEAD認証で検証する。
    input.setAttribute("aria-label", mode === "deck" ? "暗号化デッキファイル" : "暗号化バックアップファイル");
    input.addEventListener("change", () => {
      const file = input.files?.item(0);
      input.remove();
      if (file) renderImportDialog(file, mode);
    });
    root.append(input);
    input.click();
  });
  return launch;
}

function renderImportDialog(file: File, mode: ImportMode): void {
  root.replaceChildren();
  const shell = element("main", "lock-shell");
  shell.append(renderBrand());
  const panel = element("section", "lock-panel");
  panel.append(
    element("p", "kicker", mode === "deck" ? "暗号化デッキ" : "暗号化バックアップ"),
    element("h2", "lock-title", "パスフレーズを入力"),
    element("p", "file-name", file.name),
  );
  const form = element("form", "stack");
  const password = passwordInput("パスフレーズ", "current-password");
  const submit = button(mode === "deck" ? "安全に取り込む" : "安全に復元する", "button button-primary button-wide");
  submit.type = "submit";
  const cancel = button("戻る", "button button-ghost button-wide");
  cancel.addEventListener("click", () => renderLocked());
  form.append(password.label, password.input, submit, cancel);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void importEncryptedFile(file, mode, password.input, panel);
  });
  panel.append(form);
  shell.append(panel);
  root.append(shell);
}

async function readImportFile(file: File): Promise<string> {
  if (file.size <= 0 || file.size > MAX_IMPORT_BYTES) throw new Error("ファイルサイズが許容範囲外です。");
  return file.text();
}

async function unlockStoredVault(input: HTMLInputElement, panel: HTMLElement): Promise<void> {
  if (!storedEnvelope || busy) return;
  setBusy(true);
  try {
    const material = await importPassphrase(input.value);
    input.value = "";
    const payload = await decryptPayload<unknown>(storedEnvelope, material, "nwvault");
    vault = normalizeVaultPayload(payload);
    sessionMaterial = material;
    route = "home";
    renderApp();
  } catch (error) {
    input.value = "";
    panel.prepend(announce(safeError(error), "error"));
    input.focus();
  } finally {
    setBusy(false);
  }
}

async function importEncryptedFile(
  file: File,
  mode: ImportMode,
  input: HTMLInputElement,
  panel: HTMLElement,
): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const text = await readImportFile(file);
    const envelope = parseEnvelopeText(text, mode === "deck" ? "nwdeck" : "nwbackup");
    const importMaterial = await importPassphrase(input.value);
    input.value = "";
    if (mode === "deck") {
      const deck = await decryptPayload<unknown>(envelope, importMaterial, "nwdeck");
      const normalizedDeck = normalizeDeckPayload(deck);
      const nextVault: VaultPayload = vault
        ? mergeDeck(vault, normalizedDeck)
        : {
            schemaVersion: 2,
            deck: normalizedDeck,
            reviews: {},
            orphanReviews: {},
            settings: { newCardsPerDay: 10, requestRetention: 0.9, timezone: "Asia/Tokyo" },
          };
      const vaultMaterial = sessionMaterial ?? importMaterial;
      const nextEnvelope = await encryptPayload("nwvault", nextVault, vaultMaterial);
      await saveVaultEnvelope(nextEnvelope);
      storedEnvelope = nextEnvelope;
      vault = nextVault;
      sessionMaterial = vaultMaterial;
    } else {
      const backup = await decryptPayload<unknown>(envelope, importMaterial, "nwbackup");
      const normalizedBackup = normalizeVaultPayload(backup);
      const nextEnvelope = await encryptPayload("nwvault", normalizedBackup, importMaterial);
      await saveVaultEnvelope(nextEnvelope);
      storedEnvelope = nextEnvelope;
      vault = normalizedBackup;
      sessionMaterial = importMaterial;
    }
    route = "home";
    renderApp(announce(mode === "deck" ? "デッキを安全に取り込みました。" : "バックアップを復元しました。", "success"));
  } catch (error) {
    input.value = "";
    panel.prepend(announce(safeError(error), "error"));
    input.focus();
  } finally {
    setBusy(false);
  }
}

function renderHeader(): HTMLElement {
  const header = element("header", "app-header");
  const compactBrand = element("button", "compact-brand");
  compactBrand.type = "button";
  compactBrand.setAttribute("aria-label", "ホームへ戻る");
  compactBrand.append(element("span", "compact-mark", "NW"), element("span", "compact-name", "ネスペカード"));
  compactBrand.addEventListener("click", () => navigate("home"));
  const lock = button("ロック", "button button-ghost button-small");
  lock.addEventListener("click", () => lockApp("手動でロックしました。"));
  header.append(compactBrand, lock);
  return header;
}

function renderNavigation(): HTMLElement {
  const nav = element("nav", "bottom-nav");
  nav.setAttribute("aria-label", "主要メニュー");
  const entries: Array<[Route, string, string]> = [
    ["home", "⌂", "ホーム"],
    ["study", "◇", "学習"],
    ["browse", "≡", "カード"],
    ["settings", "⚙", "設定"],
  ];
  for (const [target, icon, label] of entries) {
    const item = button("", `nav-item${route === target ? " is-active" : ""}`);
    item.append(element("span", "nav-icon", icon), element("span", "nav-label", label));
    item.addEventListener("click", () => navigate(target));
    nav.append(item);
  }
  return nav;
}

function navigate(next: Route): void {
  route = next;
  if (next === "study") startStudySession();
  else renderApp();
}

function renderApp(banner?: HTMLElement): void {
  if (!vault || !sessionMaterial) return renderLocked();
  root.replaceChildren();
  const shell = element("div", "app-shell");
  shell.append(renderHeader());
  const main = element("main", "content");
  if (banner) main.append(banner);
  if (route === "home") main.append(renderHome());
  else if (route === "study") main.append(renderStudy());
  else if (route === "browse") main.append(renderBrowse());
  else main.append(renderSettings());
  shell.append(main, renderNavigation());
  root.append(shell);
}

function renderHome(): HTMLElement {
  const currentVault = vault!;
  const now = new Date();
  const counts = getStudyCounts(currentVault, now);
  const section = element("section", "page-stack");
  const heading = element("div", "page-heading");
  heading.append(
    element("p", "eyebrow", "TODAY / ACTIVE RECALL"),
    element("h2", "page-title", "今日の想起を始める"),
    element("p", "muted", "期限が来たカードを先に、新規は原則として教科書8枚・最新補足2枚。"),
  );
  section.append(heading);

  const focus = element("article", "focus-card");
  const ring = element("div", "progress-ring");
  const percent = counts.total === 0 ? 0 : Math.round((counts.learned / counts.total) * 100);
  ring.style.setProperty("--progress", `${percent * 3.6}deg`);
  ring.append(element("strong", "", `${percent}%`), element("small", "", "学習済み"));
  const focusCopy = element("div", "focus-copy");
  focusCopy.append(
    element("span", "status-pill", counts.due > 0 ? `${counts.due}枚が復習待ち` : "復習待ちはありません"),
    element("h3", "", counts.due + counts.newAvailable > 0 ? "短くても、毎日続ける" : "今日の学習は完了です"),
    element("p", "", `新規 ${counts.newAvailable}枚 / 全${counts.total}枚`),
  );
  const start = button(counts.due + counts.newAvailable > 0 ? "今日の学習を始める" : "カードを見返す", "button button-primary");
  start.addEventListener("click", () => (counts.due + counts.newAvailable > 0 ? navigate("study") : navigate("browse")));
  focus.append(ring, focusCopy, start);
  section.append(focus);

  const metrics = element("div", "metric-grid");
  metrics.append(metric("復習待ち", counts.due, "期限到来"), metric("今日の新規", counts.newAvailable, "最大10枚"), metric("学習済み", counts.learned, `全${counts.total}枚`));
  section.append(metrics);

  const chapters = element("section", "section-card");
  chapters.append(element("h3", "section-title", "章ごとの進み具合"));
  const chapterList = element("div", "chapter-list");
  const grouped = new Map<number, StudyCard[]>();
  for (const card of currentVault.deck.cards) grouped.set(card.chapter, [...(grouped.get(card.chapter) ?? []), card]);
  for (const [chapter, cards] of grouped) {
    const learned = cards.filter((card) => currentVault.reviews[card.id] !== undefined).length;
    const row = element("button", "chapter-row");
    row.type = "button";
    row.append(
      element("span", "chapter-number", String(chapter).padStart(2, "0")),
      element("span", "chapter-title", cards[0]?.chapterTitle ?? `第${chapter}章`),
      element("span", "chapter-progress", `${learned}/${cards.length}`),
    );
    row.addEventListener("click", () => {
      route = "browse";
      renderApp();
      const select = document.querySelector<HTMLSelectElement>("#filter-chapter");
      if (select) {
        select.value = String(chapter);
        select.dispatchEvent(new Event("change"));
      }
    });
    chapterList.append(row);
  }
  chapters.append(chapterList);
  section.append(chapters);
  return section;
}

function metric(label: string, value: number, note: string): HTMLElement {
  const card = element("article", "metric-card");
  card.append(element("p", "metric-label", label), element("strong", "metric-value", String(value)), element("small", "metric-note", note));
  return card;
}

function startStudySession(): void {
  if (!vault) return;
  studyQueue = buildStudyQueue(vault, new Date());
  studyIndex = 0;
  answerVisible = false;
  renderApp();
}

function renderStudy(): HTMLElement {
  const section = element("section", "study-page");
  if (studyQueue.length === 0 || studyIndex >= studyQueue.length) {
    const done = element("div", "empty-state");
    done.append(
      element("div", "done-mark", "✓"),
      element("h2", "", "今日の学習は完了"),
      element("p", "muted", "次の期限が来たら、また短く思い出しましょう。"),
    );
    const home = button("ホームへ戻る", "button button-primary");
    home.addEventListener("click", () => navigate("home"));
    done.append(home);
    section.append(done);
    return section;
  }
  const card = studyQueue[studyIndex]!;
  const progress = element("div", "study-progress");
  progress.append(element("span", "", `${studyIndex + 1} / ${studyQueue.length}`));
  const progressTrack = element("div", "progress-track");
  const progressBar = element("span", "progress-bar");
  progressBar.style.width = `${((studyIndex + 1) / studyQueue.length) * 100}%`;
  progressTrack.append(progressBar);
  progress.append(progressTrack);
  section.append(progress, renderFlashcard(card));
  return section;
}

function renderFlashcard(card: StudyCard): HTMLElement {
  const wrapper = element("article", `flashcard${answerVisible ? " is-revealed" : ""}`);
  const badges = element("div", "badge-row");
  badges.append(
    element("span", `badge badge-${card.importance.toLowerCase()}`, `重要度 ${card.importance}`),
    element("span", "badge", card.kind),
    element("span", "badge", `第${card.chapter}章`),
  );
  if (card.collectionId === "catchup") badges.append(element("span", "badge badge-catchup", "最新補足"));
  wrapper.append(badges, element("p", "card-page", card.collectionId === "catchup" ? `${card.sourceLabel} • ${card.sourceLocator}` : `紙面 p.${card.page}`), element("h2", "card-term", card.term));
  const prompt = element("div", "card-prompt");
  prompt.append(element("p", "prompt-label", answerVisible ? "問い" : "頭の中で答える"));
  if (card.kind === "4問") {
    prompt.append(element("p", "", card.prompt));
    const questions = element("ol", "question-list");
    ["何を解決する？", "何者？", "どこで働く？", "壊れたら？"].forEach((question) => questions.append(element("li", "", question)));
    prompt.append(questions);
  } else {
    prompt.append(element("p", "prompt-text", card.prompt));
  }
  wrapper.append(prompt);
  if (!answerVisible) {
    const reveal = button("答えを見る", "button button-primary button-wide reveal-button");
    reveal.addEventListener("click", () => {
      answerVisible = true;
      renderApp();
    });
    wrapper.append(reveal, element("p", "tap-hint", "カードを思い出してから開いてください"));
    wrapper.addEventListener("click", (event) => {
      if (event.target === wrapper || (event.target as HTMLElement).closest(".card-prompt")) {
        answerVisible = true;
        renderApp();
      }
    });
  } else {
    const answer = element("div", "answer-panel");
    answer.append(element("p", "prompt-label answer-label", "答え"));
    for (const part of card.answerSections) {
      const block = element("section", "answer-block");
      block.append(element("h3", "", part.label), element("p", "", part.text));
      answer.append(block);
    }
    if (card.exam) answer.append(element("p", "exam-note", `出題: ${card.exam}`));
    wrapper.append(answer, renderRelatedCards(card), renderRatingButtons(card.id));
  }
  return wrapper;
}

function renderRatingButtons(cardId: string): HTMLElement {
  const now = new Date();
  const intervals = previewIntervals(vault!, cardId, now);
  const area = element("div", "rating-area");
  area.append(element("p", "rating-prompt", "どのくらい思い出せましたか？"));
  const grid = element("div", "rating-grid");
  for (const grade of RATINGS) {
    const choice = button("", `rating rating-${grade}`);
    choice.append(element("strong", "", RATING_LABELS[grade]), element("small", "", formatInterval(intervals[grade], now)));
    choice.addEventListener("click", () => void rateCurrentCard(cardId, grade, choice));
    grid.append(choice);
  }
  area.append(grid);
  return area;
}

async function rateCurrentCard(cardId: string, grade: Grade, choice: HTMLButtonElement): Promise<void> {
  if (!vault || !sessionMaterial || busy) return;
  setBusy(true);
  choice.textContent = "保存中…";
  try {
    const nextVault = applyRating(vault, cardId, grade, new Date());
    const nextEnvelope = await encryptPayload("nwvault", nextVault, sessionMaterial);
    await saveVaultEnvelope(nextEnvelope);
    vault = nextVault;
    storedEnvelope = nextEnvelope;
    studyIndex += 1;
    answerVisible = false;
    renderApp();
  } catch (error) {
    renderApp(announce(safeError(error), "error"));
  } finally {
    setBusy(false);
  }
}

function renderBrowse(): HTMLElement {
  const section = element("section", "page-stack");
  section.append(element("div", "page-heading"));
  const heading = section.firstElementChild!;
  heading.append(element("p", "eyebrow", "CARD BANK"), element("h2", "page-title", "カードを探す"));
  const filters: CardFilters = { query: "", chapter: "all", collection: "all", importance: "all", kind: "all", state: "all" };
  const controls = element("div", "filter-panel");
  const search = element("input", "field-input search-input");
  search.type = "search";
  search.placeholder = "用語・問い・答えを検索";
  search.setAttribute("aria-label", "カードを検索");
  const chapter = selectControl("filter-chapter", "すべての章", Array.from({ length: 9 }, (_, index) => [`${index + 1}`, `第${index + 1}章`]));
  const collection = selectControl("filter-collection", "教科書＋最新補足", [["textbook-r06", "教科書"], ["catchup", "最新補足"]]);
  const importance = selectControl("filter-importance", "すべての重要度", IMPORTANCE_LEVELS.map((value) => [value, `重要度 ${value}`]));
  const kind = selectControl("filter-kind", "すべての種類", CARD_KINDS.map((value) => [value, value]));
  const state = selectControl("filter-state", "すべての状態", [["new", "未学習"], ["due", "復習待ち"], ["learned", "学習済み"]]);
  controls.append(search, chapter, collection, importance, kind, state);
  const results = element("div", "card-results");
  const renderResults = () => {
    filters.query = search.value;
    filters.chapter = chapter.value === "all" ? "all" : Number(chapter.value);
    filters.collection = collection.value as CardFilters["collection"];
    filters.importance = importance.value as CardFilters["importance"];
    filters.kind = kind.value as CardFilters["kind"];
    filters.state = state.value as CardFilters["state"];
    const cards = filterCards(vault!, filters, new Date());
    results.replaceChildren(element("p", "result-count", `${cards.length}枚`));
    const visible = cards.slice(0, 200);
    if (browseFocusId) {
      const focused = vault!.deck.cards.find((card) => card.id === browseFocusId);
      if (focused && !visible.some((card) => card.id === focused.id)) visible.unshift(focused);
    }
    for (const card of visible) results.append(renderBrowseCard(card));
    if (cards.length > 200) results.append(announce("表示負荷を抑えるため先頭200枚を表示しています。検索条件を追加してください。"));
    if (browseFocusId) {
      const focused = results.querySelector<HTMLDetailsElement>(`[data-card-id="${browseFocusId}"]`);
      if (focused) {
        focused.open = true;
        queueMicrotask(() => focused.scrollIntoView({ block: "center" }));
      }
      browseFocusId = null;
    }
  };
  search.addEventListener("input", renderResults);
  [chapter, collection, importance, kind, state].forEach((control) => control.addEventListener("change", renderResults));
  renderResults();
  section.append(controls, results);
  return section;
}

function selectControl(id: string, allLabel: string, options: ReadonlyArray<readonly [string, string]>): HTMLSelectElement {
  const select = element("select", "field-input filter-select");
  select.id = id;
  const all = element("option", "", allLabel);
  all.value = "all";
  select.append(all);
  for (const [value, label] of options) {
    const option = element("option", "", label);
    option.value = value;
    select.append(option);
  }
  return select;
}

function renderBrowseCard(card: StudyCard): HTMLElement {
  const details = element("details", "browse-card");
  details.dataset.cardId = card.id;
  const summary = element("summary", "browse-summary");
  const title = element("span", "browse-title");
  title.append(
    element("strong", "", card.term),
    element("small", "", card.collectionId === "catchup" ? `最新補足 • ${card.sourceLocator} • 第${card.chapter}章` : `教科書 • 第${card.chapter}章 • p.${card.page} • ${card.kind}`),
  );
  const status = vault!.reviews[card.id] ? "学習済" : "未学習";
  summary.append(title, element("span", `badge badge-${card.importance.toLowerCase()}`, `${card.importance} / ${status}`));
  const content = element("div", "browse-content");
  content.append(element("p", "prompt-text", card.prompt));
  for (const answer of card.answerSections) {
    const part = element("div", "browse-answer");
    part.append(element("strong", "", answer.label), element("p", "", answer.text));
    content.append(part);
  }
  content.append(renderRelatedCards(card));
  details.append(summary, content);
  return details;
}

function renderRelatedCards(card: StudyCard): HTMLElement {
  const area = element("div", "related-cards");
  if (card.relatedCardIds.length === 0) return area;
  area.append(element("strong", "related-title", "関連カード"));
  const byId = new Map(vault!.deck.cards.map((item) => [item.id, item]));
  for (const id of card.relatedCardIds) {
    const related = byId.get(id);
    if (!related) continue;
    const link = button(`${related.collectionId === "catchup" ? "最新補足" : "教科書"}: ${related.term}`, "button button-ghost button-small related-button");
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      browseFocusId = id;
      route = "browse";
      renderApp();
    });
    area.append(link);
  }
  return area;
}

function renderSettings(): HTMLElement {
  const section = element("section", "page-stack");
  const heading = element("div", "page-heading");
  heading.append(element("p", "eyebrow", "SECURE VAULT"), element("h2", "page-title", "設定と保護"));
  section.append(heading);

  const studySettings = settingsCard("学習設定", "期限到来カードは常に新規カードより先に出題します。");
  const numberLabel = element("label", "field-label", "1日の新規カード数");
  const number = element("input", "field-input");
  number.type = "number";
  number.min = "1";
  number.max = "50";
  number.inputMode = "numeric";
  number.value = String(vault!.settings.newCardsPerDay);
  const saveSettings = button("設定を保存", "button button-secondary");
  saveSettings.addEventListener("click", () => void updateSettings(Number(number.value), studySettings));
  studySettings.append(numberLabel, number, element("p", "field-help", "FSRS目標保持率: 90% / 日付基準: Asia/Tokyo"), saveSettings);
  section.append(studySettings);

  const data = settingsCard("暗号化データ", "ファイルは端末内でのみ復号され、外部へ送信されません。");
  const backup = button("暗号化バックアップを書き出す", "button button-primary button-wide");
  backup.addEventListener("click", () => void exportBackup(data));
  const update = importLauncher("暗号化デッキを更新", "deck");
  const restore = importLauncher("バックアップから復元", "backup");
  data.append(backup, update, restore);
  section.append(data);

  const password = settingsCard("パスフレーズ変更", "12文字以上または4単語以上。変更後も古いバックアップのパスフレーズは変わりません。");
  const change = button("新しいパスフレーズを設定", "button button-secondary button-wide");
  change.addEventListener("click", () => renderPassphraseChange());
  password.append(change);
  section.append(password);

  section.append(
    settingsCard(
      "ロック動作",
      "無操作やバックグラウンド経過では自動ロックしません。必要なときは画面上部の「ロック」を押してください。アプリを再起動すると再認証が必要です。",
    ),
  );

  const danger = settingsCard("端末内データの削除", "元に戻せません。復元確認済みのバックアップを2世代残してから実行してください。", "danger-card");
  const remove = button("端末内データを削除", "button button-danger button-wide");
  remove.addEventListener("click", () => renderDeleteConfirmation());
  danger.append(remove);
  section.append(danger);
  return section;
}

function settingsCard(title: string, description: string, extraClass = ""): HTMLElement {
  const card = element("section", `settings-card ${extraClass}`.trim());
  card.append(element("h3", "section-title", title), element("p", "muted", description));
  return card;
}

async function updateSettings(newCardsPerDay: number, target: HTMLElement): Promise<void> {
  if (!vault || !sessionMaterial || busy) return;
  if (!Number.isInteger(newCardsPerDay) || newCardsPerDay < 1 || newCardsPerDay > 50) {
    target.prepend(announce("新規カード数は1〜50の整数にしてください。", "error"));
    return;
  }
  setBusy(true);
  try {
    const nextVault = { ...vault, settings: { ...vault.settings, newCardsPerDay } };
    const nextEnvelope = await encryptPayload("nwvault", nextVault, sessionMaterial);
    await saveVaultEnvelope(nextEnvelope);
    vault = nextVault;
    storedEnvelope = nextEnvelope;
    renderApp(announce("学習設定を保存しました。", "success"));
  } catch (error) {
    target.prepend(announce(safeError(error), "error"));
  } finally {
    setBusy(false);
  }
}

async function exportBackup(target: HTMLElement): Promise<void> {
  if (!vault || !sessionMaterial || busy) return;
  setBusy(true);
  try {
    const envelope = await encryptPayload("nwbackup", vault, sessionMaterial);
    const blob = new Blob([JSON.stringify(envelope)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = element("a", "button button-primary button-wide download-link", "バックアップファイルを保存");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = url;
    link.download = `ネスペ暗記カード-${stamp}.nwbackup`;
    link.addEventListener("click", () => window.setTimeout(() => URL.revokeObjectURL(url), 30_000), { once: true });
    target.prepend(link);
    target.prepend(announce("暗号化バックアップを作成しました。下のボタンからFilesへ保存してください。", "success"));
  } catch (error) {
    target.prepend(announce(safeError(error), "error"));
  } finally {
    setBusy(false);
  }
}

function renderPassphraseChange(): void {
  root.replaceChildren();
  const shell = element("main", "lock-shell");
  shell.append(renderBrand());
  const panel = element("section", "lock-panel");
  panel.append(
    element("p", "kicker", "RE-ENCRYPT"),
    element("h2", "lock-title", "新しいパスフレーズ"),
    element("p", "muted", "12文字以上、または空白区切りの4単語以上。短いほど推測されやすくなります。"),
  );
  const form = element("form", "stack");
  const first = passwordInput("新しいパスフレーズ", "new-password");
  const second = passwordInput("もう一度入力", "new-password");
  const submit = button("暗号化し直す", "button button-primary button-wide");
  submit.type = "submit";
  const cancel = button("キャンセル", "button button-ghost button-wide");
  cancel.addEventListener("click", () => renderApp());
  form.append(first.label, first.input, second.label, second.input, submit, cancel);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void changePassphrase(first.input, second.input, panel);
  });
  panel.append(form);
  shell.append(panel);
  root.append(shell);
}

async function changePassphrase(first: HTMLInputElement, second: HTMLInputElement, panel: HTMLElement): Promise<void> {
  if (!vault || busy) return;
  setBusy(true);
  try {
    validatePassphrase(first.value);
    if (first.value !== second.value) throw new Error("2回のパスフレーズが一致しません。");
    const material = await importPassphrase(first.value);
    first.value = "";
    second.value = "";
    const envelope = await encryptPayload("nwvault", vault, material);
    await saveVaultEnvelope(envelope);
    storedEnvelope = envelope;
    sessionMaterial = material;
    renderApp(announce("パスフレーズを変更しました。新しいバックアップを2世代作成してください。", "success"));
  } catch (error) {
    first.value = "";
    second.value = "";
    panel.prepend(announce(safeError(error), "error"));
  } finally {
    setBusy(false);
  }
}

function renderDeleteConfirmation(): void {
  root.replaceChildren();
  const shell = element("main", "lock-shell");
  shell.append(renderBrand());
  const panel = element("section", "lock-panel danger-panel");
  panel.append(
    element("p", "kicker", "IRREVERSIBLE"),
    element("h2", "lock-title", "端末内データを削除"),
    element("p", "muted", "実行するとカード、履歴、設定がこの端末から消えます。「削除」と入力してください。"),
  );
  const input = element("input", "field-input");
  input.autocomplete = "off";
  const remove = button("完全に削除", "button button-danger button-wide");
  const cancel = button("キャンセル", "button button-ghost button-wide");
  remove.addEventListener("click", () => void confirmDelete(input, panel));
  cancel.addEventListener("click", () => renderApp());
  panel.append(input, remove, cancel);
  shell.append(panel);
  root.append(shell);
}

async function confirmDelete(input: HTMLInputElement, panel: HTMLElement): Promise<void> {
  if (input.value !== "削除") {
    panel.prepend(announce("確認欄へ「削除」と入力してください。", "error"));
    return;
  }
  await deleteVaultEnvelope();
  storedEnvelope = null;
  lockApp("端末内の暗号化データを削除しました。バックアップがあれば復元できます。");
}

export async function initializeApp(): Promise<void> {
  storedEnvelope = await loadVaultEnvelope();
  renderLocked();
  window.addEventListener("pagehide", () => {
    vault = null;
    sessionMaterial = null;
  });
}
