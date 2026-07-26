/**
 * Hope Care AI ヘルプサイト ビルドスクリプト
 *
 * 実行: node build.js
 * 必要な環境変数:
 *   NOTION_TOKEN  - Notion インテグレーションのシークレットキー
 *
 * 処理の流れ:
 *   1. Notion の4DBから「公開」記事を全件取得
 *   2. 各ページのブロックを HTML に変換
 *   3. 画像ブロックは images/ フォルダにダウンロード
 *   4. index.html の articles 配列を置き換え
 */

'use strict';

const { Client } = require('@notionhq/client');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ===== 設定 =====
const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error('❌ 環境変数 NOTION_TOKEN が設定されていません。');
  process.exit(1);
}

// Notion DB ID（環境変数で上書き可能）
const DB_GUIDE     = process.env.DB_GUIDE     || 'e357eaa3-2b46-480c-bad5-87b38cc0f2aa';
const DB_QA        = process.env.DB_QA        || '9989558f-d86a-46b3-88f7-eef62b7114e4';
const DB_TROUBLE   = process.env.DB_TROUBLE   || '621131f7-5b8a-4c3b-9aa0-42d332179166';
const DB_KNOWLEDGE = process.env.DB_KNOWLEDGE || '433a9080-4b72-48b9-9a3a-5d004eede463';

const IMAGES_DIR  = path.join(__dirname, 'images');
const INDEX_HTML  = path.join(__dirname, 'index.html');

// Notion クライアント初期化
const notion = new Client({ auth: NOTION_TOKEN });

// ===== 画像ダウンロード =====

/**
 * URL から画像をダウンロードして images/ に保存する。
 * ファイル名はブロックIDベース（差し替えても自動上書き）。
 * @returns {Promise<string>} 相対パス（例: images/abc123.png）
 */
async function downloadImage(url, blockId) {
  const ext = url.split('?')[0].match(/\.(jpe?g|png|gif|webp|svg)/i)?.[1] || 'png';
  const filename = `${blockId}.${ext}`;
  const filepath = path.join(IMAGES_DIR, filename);

  await new Promise((resolve, reject) => {
    const request = (targetUrl) => {
      const mod = targetUrl.startsWith('https') ? https : http;
      const file = fs.createWriteStream(filepath);
      mod.get(targetUrl, (res) => {
        // リダイレクト追跡
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.destroy();
          fs.unlink(filepath, () => {});
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.destroy();
          fs.unlink(filepath, () => {});
          return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (err) => {
        file.destroy();
        fs.unlink(filepath, () => {});
        reject(err);
      });
    };
    request(url);
  });

  // 白余白を自動トリミング（SVG以外）
  if (ext !== 'svg') {
    try {
      const before = await sharp(filepath).metadata();
      const trimmed = await sharp(filepath)
        .trim({ threshold: 50 })
        .toBuffer();
      const after = await sharp(trimmed).metadata();
      fs.writeFileSync(filepath, trimmed);
      if (before.width !== after.width || before.height !== after.height) {
        console.log(`    ✂️  余白削除: ${before.width}×${before.height} → ${after.width}×${after.height}`);
      }
    } catch (err) {
      console.warn(`    ⚠️  トリミングスキップ (${filename}): ${err.message}`);
    }
  }

  return `images/${filename}`;
}

// ===== リッチテキスト変換 =====

function richTextToHtml(richTexts) {
  if (!richTexts || richTexts.length === 0) return '';
  return richTexts.map(rt => {
    let text = (rt.plain_text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    if (rt.annotations?.bold)          text = `<strong>${text}</strong>`;
    if (rt.annotations?.italic)        text = `<em>${text}</em>`;
    if (rt.annotations?.code)          text = `<code>${text}</code>`;
    if (rt.annotations?.strikethrough) text = `<s>${text}</s>`;
    if (rt.href) text = `<a href="${rt.href}" target="_blank" rel="noopener">${text}</a>`;
    return text;
  }).join('');
}

// ===== ブロック → HTML 変換 =====

async function getBlockChildren(blockId) {
  const blocks = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

async function blocksToHtml(blocks) {
  let html = '';
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];

    // リスト項目はまとめて処理（子ブロックも再帰的に処理）
    if (block.type === 'bulleted_list_item') {
      html += '<ul>\n';
      while (i < blocks.length && blocks[i].type === 'bulleted_list_item') {
        const b = blocks[i];
        const text = richTextToHtml(b.bulleted_list_item.rich_text);
        let liContent = text;
        if (b.has_children) {
          const children = await getBlockChildren(b.id);
          liContent += await blocksToHtml(children);
        }
        html += `<li>${liContent}</li>\n`;
        i++;
      }
      html += '</ul>\n';
      continue;
    }
    if (block.type === 'numbered_list_item') {
      html += '<ol>\n';
      while (i < blocks.length && blocks[i].type === 'numbered_list_item') {
        const b = blocks[i];
        const text = richTextToHtml(b.numbered_list_item.rich_text);
        let liContent = text;
        if (b.has_children) {
          const children = await getBlockChildren(b.id);
          liContent += await blocksToHtml(children);
        }
        html += `<li>${liContent}</li>\n`;
        i++;
      }
      html += '</ol>\n';
      continue;
    }

    switch (block.type) {

      case 'paragraph': {
        const text = richTextToHtml(block.paragraph.rich_text);
        if (!text.trim()) break;
        // 👉 で始まる行は関連リンク
        if (text.startsWith('👉')) {
          html += `<p class="ref">${text}</p>\n`;
        } else {
          html += `<p>${text}</p>\n`;
        }
        break;
      }

      case 'heading_2': {
        html += `<h2>${richTextToHtml(block.heading_2.rich_text)}</h2>\n`;
        break;
      }

      case 'heading_3': {
        html += `<h3>${richTextToHtml(block.heading_3.rich_text)}</h3>\n`;
        break;
      }

      case 'quote': {
        const text = richTextToHtml(block.quote.rich_text);
        html += `<div class="note">${text}</div>\n`;
        break;
      }

      case 'callout': {
        const icon = block.callout.icon?.emoji || '';
        const text = richTextToHtml(block.callout.rich_text);
        let inner = icon ? `${icon} ${text}` : text;
        if (block.has_children) {
          const children = await getBlockChildren(block.id);
          inner += await blocksToHtml(children);
        }
        html += `<div class="callout">${inner}</div>\n`;
        break;
      }

      case 'divider': {
        html += '<hr>\n';
        break;
      }

      case 'image': {
        const imgBlock = block.image;
        const url = imgBlock.type === 'external'
          ? imgBlock.external.url
          : imgBlock.file?.url;
        const caption = (imgBlock.caption || []).map(rt => rt.plain_text).join('');

        if (!url) break;
        try {
          const localPath = await downloadImage(url, block.id);
          html += `<figure class="shot">`;
          html += `<img src="${localPath}" alt="${caption}">`;
          if (caption) html += `<figcaption>${caption}</figcaption>`;
          html += `</figure>\n`;
          console.log(`    📷 画像保存: ${localPath}`);
        } catch (err) {
          console.warn(`    ⚠️  画像ダウンロード失敗 (${block.id}): ${err.message}`);
          // 失敗時はプレースホルダーのまま
          html += `<figure class="shot"><div class="shot-box">`;
          html += `<span class="shot-icon">📷</span>`;
          html += `<span class="shot-text">${caption || 'スクリーンショット挿入位置'}</span>`;
          html += `<code>images/${block.id}.png</code>`;
          html += `</div></figure>\n`;
        }
        break;
      }

      case 'table': {
        const rows = await getBlockChildren(block.id);
        html += '<table>\n';
        const hasHeader = block.table.has_column_header;
        rows.forEach((row, rowIdx) => {
          if (row.type !== 'table_row') return;
          html += '<tr>';
          row.table_row.cells.forEach(cell => {
            const cellHtml = richTextToHtml(cell);
            const tag = (hasHeader && rowIdx === 0) ? 'th' : 'td';
            html += `<${tag}>${cellHtml}</${tag}>`;
          });
          html += '</tr>\n';
        });
        html += '</table>\n';
        break;
      }

      case 'toggle': {
        const text = richTextToHtml(block.toggle.rich_text);
        let inner = '';
        if (block.has_children) {
          const children = await getBlockChildren(block.id);
          inner = await blocksToHtml(children);
        }
        html += `<details><summary>${text}</summary>${inner}</details>\n`;
        break;
      }

      case 'code': {
        const text = richTextToHtml(block.code.rich_text);
        html += `<pre><code>${text}</code></pre>\n`;
        break;
      }

      default:
        // 未対応ブロックは無視
        break;
    }

    i++;
  }

  return html;
}

// ===== Notion DB クエリ =====

async function queryPublished(dbId) {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: dbId,
      filter: { property: 'ステータス', select: { equals: '公開' } },
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function getProp(page, name) {
  const prop = page.properties[name];
  if (!prop) return null;
  switch (prop.type) {
    case 'title':     return prop.title.map(rt => rt.plain_text).join('').trim();
    case 'select':    return prop.select?.name?.trim() || null;
    case 'number':    return prop.number;
    case 'rich_text': return prop.rich_text.map(rt => rt.plain_text).join('').trim();
    default:          return null;
  }
}

// ===== JS 配列文字列の生成 =====

function escapeBody(html) {
  // テンプレートリテラル内でのエスケープ
  return html
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function articlesToJs(articles) {
  return articles.map(a => {
    const lines = [
      `  tab:${JSON.stringify(a.tab)}`,
      `  category:${JSON.stringify(a.category)}`,
    ];
    if (a.tab === 'guide' || a.tab === 'knowledge') {
      lines.push(`  order:${a.order}`);
      lines.push(`  target:${JSON.stringify(a.target)}`);
    }
    lines.push(`  title:${JSON.stringify(a.title)}`);
    lines.push(`  body:\`\n${escapeBody(a.body.trim())}\n\``);
    return `{\n${lines.join(',\n')}\n}`;
  }).join(',\n');
}

// ===== メイン処理 =====

async function build() {
  console.log('🔨 Hope Care AI ヘルプサイト ビルド開始\n');

  // images/ ディレクトリを作成
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const articles = [];

  // --- 操作ガイド ---
  console.log('📘 操作ガイドを取得中...');
  const guidePages = await queryPublished(DB_GUIDE);
  console.log(`  ${guidePages.length} 件の公開記事を発見`);
  for (const page of guidePages) {
    const title    = getProp(page, 'タイトル');
    const category = getProp(page, 'カテゴリ');
    const order    = getProp(page, '表示順') ?? 999;
    const target   = getProp(page, '対象者') ?? '全員';
    if (!title || !category) continue;
    console.log(`  → [${category}] ${title}`);
    const blocks = await getBlockChildren(page.id);
    const body   = await blocksToHtml(blocks);
    articles.push({ tab: 'guide', category, order, target, title, body });
  }
  // カテゴリ内で表示順にソート
  const guideItems = articles.filter(a => a.tab === 'guide');
  guideItems.sort((a, b) => a.order - b.order);

  // --- よくある質問 ---
  console.log('\n❓ よくある質問を取得中...');
  const qaPages = await queryPublished(DB_QA);
  console.log(`  ${qaPages.length} 件の公開記事を発見`);
  for (const page of qaPages) {
    const title    = getProp(page, '質問');
    const category = getProp(page, 'カテゴリ');
    if (!title || !category) continue;
    console.log(`  → [${category}] ${title}`);
    const blocks = await getBlockChildren(page.id);
    const body   = await blocksToHtml(blocks);
    articles.push({ tab: 'qa', category, title, body });
  }

  // --- トラブルシューティング ---
  console.log('\n🔧 トラブルシューティングを取得中...');
  const troublePages = await queryPublished(DB_TROUBLE);
  console.log(`  ${troublePages.length} 件の公開記事を発見`);
  for (const page of troublePages) {
    const title    = getProp(page, '症状');
    const category = getProp(page, 'カテゴリ');
    if (!title || !category) continue;
    console.log(`  → [${category}] ${title}`);
    const blocks = await getBlockChildren(page.id);
    const body   = await blocksToHtml(blocks);
    articles.push({ tab: 'trouble', category, title, body });
  }

  // --- 活用ナレッジ ---
  console.log('\n🟩 活用ナレッジを取得中...');
  const knowledgePages = await queryPublished(DB_KNOWLEDGE);
  console.log(`  ${knowledgePages.length} 件の公開記事を発見`);
  for (const page of knowledgePages) {
    const title    = getProp(page, 'タイトル');
    const category = getProp(page, 'カテゴリ');
    const order    = getProp(page, '表示順') ?? 999;
    const target   = getProp(page, '対象者') ?? '全員';
    if (!title || !category) continue;
    console.log(`  → [${category}] ${title}`);
    const blocks = await getBlockChildren(page.id);
    const body   = await blocksToHtml(blocks);
    articles.push({ tab: 'knowledge', category, order, target, title, body });
  }
  // カテゴリ内で表示順にソート
  const knowledgeItems = articles.filter(a => a.tab === 'knowledge');
  knowledgeItems.sort((a, b) => a.order - b.order);

  // --- index.html の articles を置き換え ---
  console.log('\n📝 index.html を更新中...');
  let html = fs.readFileSync(INDEX_HTML, 'utf8');

  const articlesJs = articlesToJs(articles);

  // 正規表現を使わず indexOf で確実に置き換え
  const START = 'const articles = [';
  const END   = '/* ====== 描画 ======';
  const startIdx = html.indexOf(START);
  const endIdx   = html.indexOf(END);

  if (startIdx === -1 || endIdx === -1) {
    console.error('❌ articles 配列の置き換えに失敗しました。index.html の構造を確認してください。');
    console.error(`   START(${START}) 位置: ${startIdx}`);
    console.error(`   END(${END}) 位置: ${endIdx}`);
    process.exit(1);
  }

  const newHtml = html.substring(0, startIdx)
    + `const articles = [\n${articlesJs}\n];\n\n`
    + html.substring(endIdx);

  fs.writeFileSync(INDEX_HTML, newHtml, 'utf8');

  const gc = articles.filter(a => a.tab === 'guide').length;
  const qc = articles.filter(a => a.tab === 'qa').length;
  const tc = articles.filter(a => a.tab === 'trouble').length;
  const kc = articles.filter(a => a.tab === 'knowledge').length;

  console.log(`\n✅ ビルド完了！`);
  console.log(`   操作ガイド ${gc} 件・よくある質問 ${qc} 件・トラブルシューティング ${tc} 件・活用ナレッジ ${kc} 件`);
}

build().catch(err => {
  console.error('\n❌ ビルドエラー:', err.message);
  process.exit(1);
});
