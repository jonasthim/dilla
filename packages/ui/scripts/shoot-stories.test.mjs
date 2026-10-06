import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, VIEWPORT, selectStories, storyUrl, outFile, contentType, resolveInRoot } from './shoot-stories.mjs';

const index = {
  v: 5,
  entries: {
    'form-textfield--empty': { type: 'story', id: 'form-textfield--empty', title: 'Form/TextField', name: 'Empty' },
    'form-textfield--docs': { type: 'docs', id: 'form-textfield--docs', title: 'Form/TextField', name: 'Docs' },
    'ceremony-splash--loading': { type: 'story', id: 'ceremony-splash--loading', title: 'Ceremony/Splash', name: 'Loading' },
    'primitives-button--default': { type: 'story', id: 'primitives-button--default', title: 'Primitives/Button', name: 'Default' },
  },
};

test('selects the stories whose id starts with a prefix, sorted, and never a docs entry', () => {
  assert.deepEqual(selectStories(index, ['form-', 'ceremony-']), { ids: ['ceremony-splash--loading', 'form-textfield--empty'], unmatched: [] });
});

test('names every prefix that matched no story', () => {
  assert.deepEqual(selectStories(index, ['form-', 'shell-']), { ids: ['form-textfield--empty'], unmatched: ['shell-'] });
});

test('builds the iframe URL with the theme global and the story view mode', () => {
  assert.equal(storyUrl(6016, 'form-textfield--empty', 'high-contrast'),
    'http://127.0.0.1:6016/iframe.html?id=form-textfield--empty&globals=theme:high-contrast&viewMode=story');
});

test('shoots three themes at 1280 by 800', () => {
  assert.deepEqual(THEMES, ['mesh', 'light', 'high-contrast']);
  assert.deepEqual(VIEWPORT, { width: 1280, height: 800 });
});

test('names each file <story id>.<theme>.png inside the out dir', () => {
  assert.equal(outFile('/tmp/dw/shots', 'form-textfield--empty', 'light'), '/tmp/dw/shots/form-textfield--empty.light.png');
});

test('serves the Storybook files with their media types', () => {
  assert.equal(contentType('/iframe.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('/assets/iframe-abc.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('/assets/x.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('/assets/x.css'), 'text/css; charset=utf-8');
  assert.equal(contentType('/index.json'), 'application/json');
  assert.equal(contentType('/favicon.svg'), 'image/svg+xml');
  assert.equal(contentType('/a.woff2'), 'font/woff2');
  assert.equal(contentType('/a.png'), 'image/png');
  assert.equal(contentType('/a.unknown'), 'application/octet-stream');
});

test('maps / to index.html and refuses a path that leaves the root', () => {
  assert.equal(resolveInRoot('/srv/sb', '/'), '/srv/sb/index.html');
  assert.equal(resolveInRoot('/srv/sb', '/assets/a.js'), '/srv/sb/assets/a.js');
  assert.equal(resolveInRoot('/srv/sb', '/../etc/passwd'), null);
  assert.equal(resolveInRoot('/srv/sb', '/%2e%2e/etc/passwd'), null);
  assert.equal(resolveInRoot('/srv/sb', '/%E0%A4%A'), null);
});
