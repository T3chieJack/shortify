'use strict';

const { csrfToken, csrfValid, hashPassword, isLoggedIn } = require('../auth');
const { EXPIRY_LABELS, KIND_LABELS, LINKS_PER_PAGE, LINK_KINDS, MAX_BULK_BODY_BYTES, MAX_BULK_LINES, MAX_QUERY_LENGTH, PAGE_EXPIRED, PIN_ERROR, PIN_PATTERN, SORT_LABELS, STATE_LABELS, TAG_PATTERN } = require('../config');
const { csvRow, isoTime, startCsv } = require('../csv');
const { LINK_ORDERS, countFilteredLinks, db, defaultDomainId, deleteTag, exportLinks, findLinkById, insertLink, insertTag, listLinks, listTags, updateLinkDomain, updateLinkExpiry, updateLinkLimit, updateLinkPin, updateLinkSlug, updateLinkTarget } = require('../db');
const { dayString, formatCount, formatLongDate, nowSeconds, optionsHtml, plural } = require('../format');
const { escapeHtml, fieldAria, fieldError, readForm, redirect, sendHtml, sendText } = require('../http');
const { renderSidebar } = require('../layout');
const { checkSlug, domainOptionsHtml, generateSlug, linkTarget, linkTargetCell, parseClickLimit, parseDomainChoice, parseExpiry, parseLinkUrl, parseTags, removeLinks, shortLabel, shortLinkHtml, shortUrl } = require('../links');
const { LINKS_PAGE, renderTemplate } = require('../views');

function parseLinksQuery(params) {
  const kind = params.get('kind');
  const sort = params.get('sort');
  const tag = (params.get('tag') || '').toLowerCase();
  const state = params.get('state');
  const page = Number(params.get('page'));
  return {
    q: (params.get('q') || '').trim().slice(0, MAX_QUERY_LENGTH),
    kind: LINK_KINDS.includes(kind) ? kind : '',
    tag: TAG_PATTERN.test(tag) ? tag : '',
    state: state && Object.hasOwn(STATE_LABELS, state) ? state : '',
    sort: Object.hasOwn(LINK_ORDERS, sort) ? sort : 'newest',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

function linksQueryString({ q, kind, tag, state, sort, page }) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (kind) params.set('kind', kind);
  if (tag) params.set('tag', tag);
  if (state) params.set('state', state);
  if (sort !== 'newest') params.set('sort', sort);
  if (page > 1) params.set('page', page);
  return params.toString();
}

function linksUrl(query, notice = {}) {
  const params = new URLSearchParams(linksQueryString(query));
  for (const [name, value] of Object.entries(notice)) params.set(name, value);
  const queryString = params.toString();
  return queryString ? `/links?${queryString}` : '/links';
}

function linkRowHtml(req, link) {
  const slug = escapeHtml(link.slug);
  const url = escapeHtml(shortUrl(req, link));
  return `<tr>
              <td class="cell-check"><input class="row-check" type="checkbox" name="ids" value="${link.id}" data-slug="${slug}" data-url="${url}" aria-label="Select /${slug}"></td>
              <td class="cell-slug">${shortLinkHtml(req, link)}</td>
              ${linkTargetCell(link).replace('<td', '<td class="cell-target"')}
              <td class="cell-clicks">${formatCount(link.clicks)}<span class="cell-unit"> ${link.clicks === 1 ? 'click' : 'clicks'}</span></td>
              <td class="cell-created">${formatLongDate(new Date(link.created_at * 1000))}</td>
              <td class="cell-actions">
                <a class="button-text" href="/links/view?id=${link.id}" aria-label="Details for /${slug}">Details</a>
                <button class="button-text row-copy" type="button" data-url="${url}" hidden aria-label="Copy /${slug}">Copy</button>
                <button class="button-text" type="submit" formaction="/links/edit" name="id" value="${link.id}" aria-label="Edit /${slug}">Edit</button>
                <button class="button-text button-text-danger" type="submit" name="id" value="${link.id}" aria-label="Delete /${slug}">Delete</button>
              </td>
            </tr>`;
}

function linksTableHtml(req, links, query) {
  if (links.length === 0) {
    const filtered = query.q || query.kind || query.tag || query.state;
    const message = filtered ? 'No links match that. Try a different search or type.' : 'No short links yet. Create one, or add many at once above.';
    return `<p class="empty links-empty">${message}</p>`;
  }
  return `<table class="all-links">
            <thead>
              <tr>
                <th class="cell-check" scope="col"><input id="select-all" type="checkbox" aria-label="Select all links on this page" hidden></th>
                <th class="cell-slug" scope="col">Short link</th>
                <th class="cell-target" scope="col">Goes to</th>
                <th class="cell-clicks" scope="col">Clicks</th>
                <th class="cell-created" scope="col">Created</th>
                <th class="cell-actions" scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
            ${links.map((link) => linkRowHtml(req, link)).join('\n            ')}
            </tbody>
          </table>`;
}

function paginationHtml(query, lastPage) {
  if (lastPage <= 1) return '';
  const pageLink = (page, label, rel) => `<a class="button-text" href="${escapeHtml(linksUrl({ ...query, page }))}" rel="${rel}">${label}</a>`;
  const previous = query.page > 1 ? pageLink(query.page - 1, 'Previous', 'prev') : '';
  const next = query.page < lastPage ? pageLink(query.page + 1, 'Next', 'next') : '';
  return `<nav class="pagination" aria-label="Pages of links">
            ${previous}
            <span>Page ${query.page} of ${lastPage}</span>
            ${next}
          </nav>`;
}

function noticeHtml(params) {
  const count = (name) => {
    const value = Number(params.get(name));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  let message = '';
  if (count('added')) message = `Added ${plural(count('added'), 'link')}.`;
  if (count('deleted')) message = `Deleted ${plural(count('deleted'), 'link')}.`;
  if (count('edited')) message = `Updated ${plural(count('edited'), 'link')}.`;
  return message ? `<p class="notice" role="status">${message}</p>` : '';
}

function selectedLinksList(links) {
  return links.map((link) => {
    const cell = linkTargetCell(link).replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '');
    return `<li><strong>${escapeHtml(shortLabel(link))}</strong> <span>${cell}</span></li>`;
  }).join('\n          ');
}

function expiryFieldHtml(idPrefix, labels, selected, date, error) {
  return `<div class="field expiry">
            <label for="${idPrefix}-expiry">Expires</label>
            <select id="${idPrefix}-expiry" name="expiry">${optionsHtml(labels, selected)}</select>
            <div class="expiry-date">
              <label class="visually-hidden" for="${idPrefix}-expiry-date">Expiry date</label>
              <input id="${idPrefix}-expiry-date" name="expiry_date" type="date" value="${escapeHtml(date)}">
              <p class="field-hint">The link stops working at the end of that day, UTC.</p>
            </div>
            ${fieldError(`${idPrefix}-expiry-error`, error)}
          </div>`;
}

function editLinksHtml(req, { links, pinError, slugError, urlError, expiryError, limitError, tagsError, pinAction = 'keep', domain = 'keep', slug, url, expiry = 'keep', expiryDate = '', limit = '', addTags = '', removeTags = '' }, csrf, query) {
  const count = plural(links.length, 'link');
  const [only] = links.length === 1 ? links : [null];
  const slugField = only ? `<div class="field">
            <label for="edit-slug">Ending</label>
            <input id="edit-slug" name="slug" type="text" value="${escapeHtml(slug ?? only.slug)}" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64" ${fieldAria('edit-slug-error', slugError)}>
            <p class="field-hint">Changing this stops the old short link working straight away.</p>
            ${fieldError('edit-slug-error', slugError)}
          </div>` : '';
  const urlField = only && only.kind === 'url' ? `<div class="field">
            <label for="edit-url">Goes to</label>
            <input id="edit-url" name="url" type="text" inputmode="url" value="${escapeHtml(url ?? only.url)}" autocomplete="off" autocapitalize="none" spellcheck="false" ${fieldAria('edit-url-error', urlError)}>
            ${fieldError('edit-url-error', urlError)}
          </div>` : '';
  const expiryLabels = { keep: 'Keep as it is', '': 'Never (remove expiry)', ...Object.fromEntries(Object.entries(EXPIRY_LABELS).slice(1)) };
  const pinChoice = (value, label) => `<label class="check-row"><input type="radio" name="pin_action" value="${value}"${pinAction === value ? ' checked' : ''}><span>${label}</span></label>`;
  return `<section class="card confirm-card edit-links">
        <h2>Edit ${count}</h2>
        <ul class="confirm-list">
          ${selectedLinksList(links)}
        </ul>
        <form method="post" action="/links/edit">
          <input type="hidden" name="csrf_token" value="${csrf}">
          <input type="hidden" name="return" value="${escapeHtml(linksQueryString(query))}">
          <input type="hidden" name="apply" value="1">
          ${links.map((link) => `<input type="hidden" name="ids" value="${link.id}">`).join('\n          ')}
          ${urlField}
          ${slugField}
          <div class="field">
            <label for="edit-domain">Domain</label>
            <select id="edit-domain" name="domain"><option value="keep"${domain === 'keep' ? ' selected' : ''}>Keep as it is</option>${domainOptionsHtml(req, domain)}</select>
            <p class="field-hint">The old address keeps working as long as that domain still reaches this server.</p>
          </div>
          <fieldset class="pin-choices">
            <legend>PIN</legend>
            ${pinChoice('keep', 'Keep as it is')}
            ${pinChoice('set', 'Set a new PIN')}
            ${pinChoice('remove', 'Remove the PIN')}
          </fieldset>
          <div class="field">
            <label for="edit-pin">New PIN</label>
            <input id="edit-pin" name="pin" type="text" inputmode="numeric" autocomplete="off" maxlength="12" ${fieldAria('edit-pin-error', pinError)}>
            <p class="field-hint">4 to 12 digits. Used only with "Set a new PIN". It can't be shown again.</p>
            ${fieldError('edit-pin-error', pinError)}
          </div>
          ${expiryFieldHtml('edit', expiryLabels, expiry, expiryDate, expiryError)}
          <div class="field">
            <label for="edit-limit">Click limit</label>
            <input id="edit-limit" name="limit" type="text" inputmode="numeric" value="${escapeHtml(limit)}" autocomplete="off" ${fieldAria('edit-limit-error', limitError)}>
            <p class="field-hint">Leave blank to keep it. Enter 0 to remove it. A new limit counts from now, which also brings back a link that ran out.</p>
            ${fieldError('edit-limit-error', limitError)}
          </div>
          <div class="field">
            <label for="edit-add-tags">Add tags</label>
            <input id="edit-add-tags" name="add_tags" type="text" value="${escapeHtml(addTags)}" autocomplete="off" autocapitalize="none" spellcheck="false" ${fieldAria('edit-tags-error', tagsError)}>
            <p class="field-hint">Separate tags with commas or spaces.</p>
            ${fieldError('edit-tags-error', tagsError)}
          </div>
          <div class="field">
            <label for="edit-remove-tags">Remove tags</label>
            <input id="edit-remove-tags" name="remove_tags" type="text" value="${escapeHtml(removeTags)}" autocomplete="off" autocapitalize="none" spellcheck="false">
          </div>
          <div class="confirm-actions">
            <button class="button button-small" type="submit">Save changes</button>
            <a class="button-text" href="${escapeHtml(linksUrl(query))}">Cancel</a>
          </div>
        </form>
      </section>`;
}

function confirmDeleteHtml(links, csrf, query) {
  const count = plural(links.length, 'link');
  return `<section class="card confirm-card">
        <h2>Delete ${count}?</h2>
        <p>These short links will stop working and their click counts will go too. Any shared text and files are removed for good. You can't undo this.</p>
        <ul class="confirm-list">
          ${selectedLinksList(links)}
        </ul>
        <form class="confirm-actions" method="post" action="/links/delete">
          <input type="hidden" name="csrf_token" value="${csrf}">
          <input type="hidden" name="return" value="${escapeHtml(linksQueryString(query))}">
          <input type="hidden" name="confirm" value="1">
          ${links.map((link) => `<input type="hidden" name="ids" value="${link.id}">`).join('\n          ')}
          <button class="button button-small button-danger" type="submit">Delete ${count}</button>
          <a class="button-text" href="${escapeHtml(linksUrl(query))}">Keep them</a>
        </form>
      </section>`;
}

function linksFilter(query) {
  return {
    like: query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null,
    kind: query.kind || null,
    tag: query.tag || null,
    state: query.state || null,
    now: nowSeconds(),
  };
}

function renderLinks(req, res, status, { params = new URLSearchParams(), confirm, edit, bulkUrls = '', bulkError } = {}) {
  const query = parseLinksQuery(params);
  const csrf = csrfToken(req, res);
  const filter = linksFilter(query);

  const total = countFilteredLinks.get(filter).count;
  const lastPage = Math.max(Math.ceil(total / LINKS_PER_PAGE), 1);
  query.page = Math.min(query.page, lastPage);
  const links = listLinks[query.sort].all({ ...filter, limit: LINKS_PER_PAGE, offset: (query.page - 1) * LINKS_PER_PAGE });

  const values = {
    sidebar: renderSidebar(req, csrf, 'links'),
    csrf_token: csrf,
    notice: noticeHtml(params),
    confirm: (confirm && confirmDeleteHtml(confirm, csrf, query)) || (edit && editLinksHtml(req, edit, csrf, query)) || '',
    list_hidden: confirm || edit ? 'hidden' : '',
    add_open: bulkError ? 'open' : '',
    max_bulk_lines: MAX_BULK_LINES,
    bulk_urls: escapeHtml(bulkUrls),
    bulk_aria: fieldAria('bulk-error', bulkError),
    bulk_error: fieldError('bulk-error', bulkError),
    q: escapeHtml(query.q),
    kind_options: optionsHtml({ '': 'All types', ...KIND_LABELS }, query.kind),
    sort_options: optionsHtml(SORT_LABELS, query.sort),
    state_options: optionsHtml(STATE_LABELS, query.state),
    tag_filter: tagFilterHtml(query.tag),
    export_query: escapeHtml(linksQueryString({ ...query, page: 1 })),
    return_query: escapeHtml(linksQueryString(query)),
    result_count: plural(total, 'link'),
    table: linksTableHtml(req, links, query),
    pagination: paginationHtml(query, lastPage),
  };
  sendHtml(res, status, renderTemplate(LINKS_PAGE, values));
}

function tagFilterHtml(current) {
  const tags = listTags.all();
  if (tags.length === 0) return '';
  const labels = { '': 'Any tag', ...Object.fromEntries(tags.map(({ tag, count }) => [tag, `#${tag} (${formatCount(count)})`])) };
  return `<div>
            <label class="visually-hidden" for="tag">Tag</label>
            <select id="tag" name="tag" data-auto-submit>${optionsHtml(labels, current)}</select>
          </div>`;
}

function sendLinksCsv(req, res, params) {
  const query = parseLinksQuery(params);
  startCsv(res, `shortify-links-${dayString()}.csv`);
  res.write(csvRow(['short_link', 'type', 'goes_to', 'clicks', 'created', 'expires', 'click_limit', 'opens_used', 'has_pin', 'tags']));
  for (const link of exportLinks.iterate(linksFilter(query))) {
    res.write(csvRow([shortUrl(req, link), link.kind, linkTarget(link), link.clicks, isoTime(link.created_at), isoTime(link.expires_at), link.click_limit, link.uses, link.has_pin ? 'yes' : 'no', link.tags]));
  }
  res.end();
}

async function handleBulkAdd(req, res) {
  if (!isLoggedIn(req)) return redirect(res, '/');
  if (Number(req.headers['content-length']) > MAX_BULK_BODY_BYTES) {
    req.resume();
    return renderLinks(req, res, 413, { bulkError: `That's too much at once. Add up to ${MAX_BULK_LINES} links at a time.` });
  }

  const form = await readForm(req, MAX_BULK_BODY_BYTES);
  if (!csrfValid(req, form)) return sendText(res, 403, PAGE_EXPIRED);

  const input = form.get('urls') || '';
  const lines = [...new Set(input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  if (lines.length === 0) return renderLinks(req, res, 400, { bulkError: 'Enter at least one link.' });
  if (lines.length > MAX_BULK_LINES) {
    return renderLinks(req, res, 400, { bulkUrls: input, bulkError: `That's ${formatCount(lines.length)} links. Add up to ${MAX_BULK_LINES} at a time.` });
  }

  const valid = [];
  const invalid = [];
  const claimed = new Set();
  for (const line of lines) {
    const [address, ending, ...extra] = line.split(/\s+/);
    try {
      if (extra.length) throw new Error('Too many parts.');
      if (ending) {
        checkSlug(ending);
        if (claimed.has(ending.toLowerCase())) throw new Error('Used twice.');
        claimed.add(ending.toLowerCase());
      }
      valid.push({ url: parseLinkUrl(address), slug: ending });
    } catch {
      invalid.push(line);
    }
  }

  db.exec('BEGIN');
  for (const { url, slug } of valid) {
    insertLink.run({ slug: slug || generateSlug(), url, createdAt: nowSeconds(), kind: 'url', content: null, fileId: null, fileName: null, fileSize: null, domainId: defaultDomainId(), pinHash: null, expiresAt: null, clickLimit: null });
  }
  db.exec('COMMIT');

  if (invalid.length > 0) {
    const added = valid.length ? `Added ${plural(valid.length, 'link')}. ` : '';
    const problem = invalid.length === 1 ? 'The line left here has a bad address or an ending that\'s taken.' : `The ${invalid.length} lines left here have bad addresses or endings that are taken.`;
    return renderLinks(req, res, 400, { bulkUrls: invalid.join('\n'), bulkError: `${added}${problem} Fix them and add again.` });
  }
  return redirect(res, linksUrl(parseLinksQuery(new URLSearchParams()), { added: valid.length }));
}

function selectedLinks(form) {
  const params = new URLSearchParams(form.get('return') || '');
  const query = parseLinksQuery(params);
  const requested = form.get('id') ? [form.get('id')] : form.getAll('ids');
  const links = [...new Set(requested.map(Number))]
    .filter(Number.isSafeInteger)
    .slice(0, LINKS_PER_PAGE)
    .map((id) => findLinkById.get(id))
    .filter(Boolean);
  return { params, query, links };
}

async function handleEditLinks(req, res) {
  if (!isLoggedIn(req)) return redirect(res, '/');
  const form = await readForm(req);
  if (!csrfValid(req, form)) return sendText(res, 403, PAGE_EXPIRED);

  const { params, query, links } = selectedLinks(form);
  if (links.length === 0) return redirect(res, linksUrl(query));
  if (form.get('apply') !== '1') return renderLinks(req, res, 200, { params, edit: { links } });

  const pinAction = form.get('pin_action') || 'keep';
  const pin = (form.get('pin') || '').trim();
  const domain = form.get('domain') || 'keep';
  const expiry = form.get('expiry') ?? 'keep';
  const expiryDate = form.get('expiry_date') || '';
  const limit = (form.get('limit') || '').trim();
  const addTags = (form.get('add_tags') || '').trim();
  const removeTags = (form.get('remove_tags') || '').trim();
  const fields = { links, pinAction, domain, expiry, expiryDate, limit, addTags, removeTags, slug: form.get('slug') ?? undefined, url: form.get('url') ?? undefined };
  const refuse = (errors) => renderLinks(req, res, 400, { params, edit: { ...fields, ...errors } });

  const [only] = links.length === 1 ? links : [null];
  const changes = {};
  if (only && form.has('url') && only.kind === 'url') {
    try {
      changes.url = parseLinkUrl(form.get('url').trim());
    } catch (error) {
      return refuse({ urlError: error.message });
    }
  }
  if (only && form.has('slug')) {
    const slug = form.get('slug').trim();
    if (slug !== only.slug) {
      const sameEnding = slug.toLowerCase() === only.slug.toLowerCase();
      try {
        if (!sameEnding) checkSlug(slug);
        changes.slug = slug;
      } catch (error) {
        return refuse({ slugError: error.message });
      }
    }
  }
  if (pinAction === 'set' && !PIN_PATTERN.test(pin)) return refuse({ pinError: PIN_ERROR });
  if (expiry !== 'keep') {
    try {
      changes.expiresAt = parseExpiry(expiry, expiryDate);
    } catch (error) {
      return refuse({ expiryError: error.message });
    }
  }
  if (limit) {
    try {
      changes.clickLimit = limit === '0' ? null : parseClickLimit(limit);
    } catch (error) {
      return refuse({ limitError: error.message });
    }
  }
  let tagsToAdd;
  let tagsToRemove;
  try {
    tagsToAdd = parseTags(addTags);
    tagsToRemove = parseTags(removeTags);
  } catch (error) {
    return refuse({ tagsError: error.message });
  }

  const pinHash = pinAction === 'set' ? await hashPassword(pin) : null;
  const domainId = domain === 'keep' ? null : parseDomainChoice(domain);
  db.exec('BEGIN');
  for (const link of links) {
    if (domain !== 'keep') updateLinkDomain.run(domainId, link.id);
    if (pinAction === 'set' || pinAction === 'remove') updateLinkPin.run(pinHash, link.id);
    if (changes.url !== undefined) updateLinkTarget.run(changes.url, link.id);
    if (changes.slug !== undefined) updateLinkSlug.run(changes.slug, link.id);
    if (changes.expiresAt !== undefined) updateLinkExpiry.run(changes.expiresAt, link.id);
    if (changes.clickLimit !== undefined) updateLinkLimit.run(changes.clickLimit, link.id);
    for (const tag of tagsToAdd) insertTag.run(link.id, tag);
    for (const tag of tagsToRemove) deleteTag.run(link.id, tag);
  }
  db.exec('COMMIT');
  return redirect(res, linksUrl(query, { edited: links.length }));
}

async function handleDeleteLinks(req, res) {
  if (!isLoggedIn(req)) return redirect(res, '/');
  const form = await readForm(req);
  if (!csrfValid(req, form)) return sendText(res, 403, PAGE_EXPIRED);

  const { params, query, links } = selectedLinks(form);
  if (links.length === 0) return redirect(res, linksUrl(query));
  if (form.get('confirm') !== '1') return renderLinks(req, res, 200, { params, confirm: links });

  await removeLinks(links);
  return redirect(res, linksUrl(query, { deleted: links.length }));
}

module.exports = {
  expiryFieldHtml,
  handleBulkAdd,
  handleDeleteLinks,
  handleEditLinks,
  linksFilter,
  parseLinksQuery,
  renderLinks,
  sendLinksCsv,
};
