import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAudioFile,
  isCodeFile,
  isMarkdownFile,
  isVideoFile,
  resolveMediaMimeType,
} from '@/lib/formatters';
import {
  PDF_ZOOM_DEFAULT,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  clampPdfZoom,
  formatPdfZoomPercent,
  resolvePreviewKind,
  rotatePdfClockwise,
  stepPdfZoom,
} from '@/lib/preview-controls';
import {
  parseMarkdownBlocks,
  parseMarkdownInlines,
  sanitizeMarkdownUrl,
} from '@/lib/preview-markdown';

test('detects video, audio, markdown, and code files by extension and MIME type', () => {
  for (const ext of ['mp4', 'webm', 'mov', 'm4v', 'ogv']) {
    assert.equal(isVideoFile(`clip.${ext}`, null), true);
    assert.equal(resolvePreviewKind(`clip.${ext}`, null), 'video');
  }
  assert.equal(isVideoFile('blob-no-ext', 'video/mp4'), true);
  assert.equal(resolvePreviewKind('blob-no-ext', 'video/webm'), 'video');

  for (const ext of ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']) {
    assert.equal(isAudioFile(`track.${ext}`, null), true);
    assert.equal(resolvePreviewKind(`track.${ext}`, null), 'audio');
  }
  assert.equal(isAudioFile('blob-no-ext', 'audio/mpeg'), true);
  assert.equal(resolvePreviewKind('blob-no-ext', 'audio/ogg'), 'audio');

  assert.equal(isMarkdownFile('README.md', null), true);
  assert.equal(isMarkdownFile('notes.MARKDOWN', null), true);
  assert.equal(isMarkdownFile('readme', 'text/markdown'), true);
  assert.equal(resolvePreviewKind('README.md', 'text/markdown'), 'markdown');

  for (const ext of [
    'ts',
    'tsx',
    'js',
    'jsx',
    'json',
    'yaml',
    'yml',
    'xml',
    'css',
    'sql',
    'py',
    'sh',
  ]) {
    assert.equal(isCodeFile(`sample.${ext}`, null), true);
    assert.equal(resolvePreviewKind(`sample.${ext}`, null), 'code');
  }

  // Active web files and source_text grants stay in active_source for XSS safety.
  assert.equal(resolvePreviewKind('page.html', 'text/html'), 'active_source');
  assert.equal(resolvePreviewKind('icon.svg', 'image/svg+xml'), 'active_source');
  assert.equal(
    resolvePreviewKind('README.md', 'text/markdown', 'source_text'),
    'active_source'
  );
  assert.equal(resolvePreviewKind('notes.txt', 'text/plain'), 'text');
  assert.equal(resolvePreviewKind('archive.bin', 'application/octet-stream'), 'fallback');
});

test('resolveMediaMimeType preserves explicit MIME and infers missing media MIME', () => {
  assert.equal(resolveMediaMimeType('video.mp4', 'video/mp4'), 'video/mp4');
  assert.equal(resolveMediaMimeType('video.mp4', 'application/octet-stream'), 'video/mp4');
  assert.equal(resolveMediaMimeType('track.mp3', null), 'audio/mpeg');
  assert.equal(resolveMediaMimeType('track.flac', undefined), 'audio/flac');
  assert.equal(resolveMediaMimeType('unknown.bin', null), 'application/octet-stream');
});

test('PDF zoom clamping, stepping, formatting, and clockwise rotation wrapping', () => {
  assert.equal(clampPdfZoom(0.1), PDF_ZOOM_MIN);
  assert.equal(clampPdfZoom(5.0), PDF_ZOOM_MAX);
  assert.equal(clampPdfZoom(Number.NaN), PDF_ZOOM_DEFAULT);
  assert.equal(clampPdfZoom(1.25), 1.25);

  assert.equal(stepPdfZoom(1.0, 1), 1.25);
  assert.equal(stepPdfZoom(1.0, -1), 0.75);
  assert.equal(stepPdfZoom(PDF_ZOOM_MAX, 1), PDF_ZOOM_MAX);
  assert.equal(stepPdfZoom(PDF_ZOOM_MIN, -1), PDF_ZOOM_MIN);

  assert.equal(formatPdfZoomPercent(1.0), '100%');
  assert.equal(formatPdfZoomPercent(1.75), '175%');
  assert.equal(formatPdfZoomPercent(0.2), '50%');

  assert.equal(rotatePdfClockwise(0), 90);
  assert.equal(rotatePdfClockwise(90), 180);
  assert.equal(rotatePdfClockwise(180), 270);
  assert.equal(rotatePdfClockwise(270), 0);
});

test('safe Markdown parser structures blocks and neutralizes XSS payloads', () => {
  assert.equal(sanitizeMarkdownUrl('https://example.com/docs?a=1'), 'https://example.com/docs?a=1');
  assert.equal(sanitizeMarkdownUrl('http://localhost:3000/test'), 'http://localhost:3000/test');
  assert.equal(sanitizeMarkdownUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeMarkdownUrl('java\u0000script:alert(1)'), null);
  assert.equal(sanitizeMarkdownUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeMarkdownUrl('vbscript:msgbox(1)'), null);
  assert.equal(sanitizeMarkdownUrl('/relative/path'), null);

  const md = [
    '# Title <script>alert(1)</script>',
    '',
    'Paragraph with **bold**, *italic*, `inline()`, [safe](https://example.com) and [xss](javascript:alert(1)).',
    '',
    '- item 1 <img src=x onerror=alert(1)>',
    '- item 2',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted line',
    '',
    '```ts',
    'const x = "<script>alert(1)</script>";',
    '```',
    '',
    '---',
  ].join('\n');

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 7);

  assert.equal(blocks[0].kind, 'heading');
  if (blocks[0].kind === 'heading') {
    assert.equal(blocks[0].level, 1);
    assert.deepEqual(blocks[0].inlines, [
      { kind: 'text', text: 'Title <script>alert(1)</script>' },
    ]);
  }

  assert.equal(blocks[1].kind, 'paragraph');
  if (blocks[1].kind === 'paragraph') {
    const links = blocks[1].inlines.filter((n) => n.kind === 'link');
    assert.deepEqual(links, [
      { kind: 'link', label: 'safe', href: 'https://example.com/' },
    ]);
    assert.equal(
      blocks[1].inlines.some((n) => n.kind === 'text' && n.text === 'xss'),
      true
    );
  }

  assert.equal(blocks[2].kind, 'list');
  if (blocks[2].kind === 'list') {
    assert.equal(blocks[2].ordered, false);
    assert.equal(blocks[2].items.length, 2);
  }

  assert.equal(blocks[3].kind, 'list');
  if (blocks[3].kind === 'list') {
    assert.equal(blocks[3].ordered, true);
    assert.equal(blocks[3].items.length, 2);
  }

  assert.equal(blocks[4].kind, 'blockquote');
  assert.equal(blocks[5].kind, 'code');
  if (blocks[5].kind === 'code') {
    assert.equal(blocks[5].language, 'ts');
    assert.equal(blocks[5].code, 'const x = "<script>alert(1)</script>";');
  }
  assert.equal(blocks[6].kind, 'hr');

  const inlineXss = parseMarkdownInlines('[bad](data:text/html;base64,PHNjcmlwdD4=)');
  assert.deepEqual(inlineXss, [{ kind: 'text', text: 'bad' }]);
});
