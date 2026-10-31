'use strict';

const { sessionUser } = require('./auth');
const { analytics } = require('./db');
const { escapeHtml } = require('./http');
const { SIDEBAR, renderTemplate } = require('./views');

function renderSidebar(req, csrf, currentPage) {
  const values = {
    username: escapeHtml(sessionUser(req).username),
    csrf_token: csrf,
    nav_dashboard: currentPage === 'dashboard' ? 'aria-current="page"' : '',
    nav_links: currentPage === 'links' ? 'aria-current="page"' : '',
    nav_settings: currentPage === 'settings' ? 'aria-current="page"' : '',
    nav_analytics: analytics.isEnabled()
      ? `<a class="nav-item" href="/analytics"${currentPage === 'analytics' ? ' aria-current="page"' : ''}>Analytics</a>`
      : '',
  };
  return renderTemplate(SIDEBAR, values);
}

module.exports = {
  renderSidebar,
};
