/* ==========================================================================
   ProjectFlow — Full-Stack Single-Page Application Logic
   ========================================================================== */

// Utility DOM selector
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

// Application State
let token = localStorage.getItem('projectflow_token');
let currentUser = null;
let allProjects = [];
let currentProject = null;
let currentTask = null;
let socket = null;
let authMode = 'login';

// Filter state for board
let taskFilter = {
  search: '',
  assignee: 'all',
  priority: 'all'
};

// API Client Helper
async function api(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers
  };

  try {
    const response = await fetch(url, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      // Session expired or invalid
      handleLogout();
      throw new Error(data.error || 'Session expired. Please sign in again.');
    }
    if (!response.ok) {
      throw new Error(data.error || `Request failed with status ${response.status}`);
    }
    return data;
  } catch (err) {
    throw err;
  }
}

// Toast notification system
function showToast(message, type = 'info') {
  const container = $('#toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const iconSvg = type === 'success' 
    ? '<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>'
    : type === 'error'
    ? '<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>'
    : '<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>';

  toast.innerHTML = `${iconSvg}<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 260);
  }, 3500);
}

// HTML Escaping
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char];
  });
}

// User Initials helper
function getUserInitials(name = 'User') {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (name[0] || 'U').toUpperCase();
}

// Format relative date
function formatRelativeTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);

  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Generic Modal Management
function openGenericModal(title, bodyHtml) {
  const modal = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  modal.showModal();
}

function closeGenericModal() {
  $('#modal').close();
}

$('#modalCloseBtn').onclick = closeGenericModal;

// ==========================================================================
// Authentication System
// ==========================================================================

function setupAuth() {
  // Tabs switcher
  $$('[data-auth]').forEach((tab) => {
    tab.onclick = () => {
      authMode = tab.dataset.auth;
      $$('[data-auth]').forEach((t) => t.classList.toggle('active', t === tab));
      $('#nameGroup').style.display = authMode === 'register' ? 'block' : 'none';
      $('#authSubmit').querySelector('span').textContent = authMode === 'register' ? 'Create Account' : 'Sign In';
      $('#password').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    };
  });

  // Password toggle
  $('#togglePasswordBtn').onclick = () => {
    const pwd = $('#password');
    pwd.type = pwd.type === 'password' ? 'text' : 'password';
  };

  // Auth Form Submit
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();
    const password = $('#password').value;
    const name = $('#name').value.trim();

    if (!email || !password) {
      showToast('Please enter your email and password.', 'error');
      return;
    }

    if (authMode === 'register' && !name) {
      showToast('Please enter your full name.', 'error');
      return;
    }

    const payload = { email, password };
    if (authMode === 'register') payload.name = name;

    const submitBtn = $('#authSubmit');
    submitBtn.disabled = true;

    try {
      const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const data = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      token = data.token;
      localStorage.setItem('projectflow_token', token);
      currentUser = data.user;
      showToast(`Welcome back, ${currentUser.name}!`, 'success');

      // Transition to Application View
      await initializeApp();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  };

}

function handleLogout() {
  localStorage.removeItem('projectflow_token');
  token = null;
  currentUser = null;
  currentProject = null;
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  $('#appView').hidden = true;
  $('#authView').hidden = false;
  $('#userDropdown').hidden = true;
  $('#userDropdown').style.display = 'none';
  toggleNotificationPanel(false);
  showToast('Signed out successfully.', 'info');
}

// ==========================================================================
// Application Core & Navigation
// ==========================================================================

async function initializeApp() {
  try {
    // 1. Fetch current authenticated user
    if (!currentUser) {
      const meData = await api('/api/auth/me');
      currentUser = meData.user;
    }

    // Switch view to app
    $('#authView').hidden = true;
    $('#appView').hidden = false;

    // Populate user profile UI
    $('#userName').textContent = currentUser.name;
    $('#userAvatar').textContent = getUserInitials(currentUser.name);
    $('#userAvatar').style.background = currentUser.avatar_color || '#6366f1';
    $('#dropdownUserName').textContent = currentUser.name;
    $('#dropdownUserEmail').textContent = currentUser.email;
    $('#dashboardGreeting').textContent = `Welcome back, ${currentUser.name.split(' ')[0]}! 👋`;

    // Setup Header User Dropdown
    $('#userChip').onclick = (e) => {
      e.stopPropagation();
      const dropdown = $('#userDropdown');
      const willOpen = dropdown.hidden || dropdown.style.display === 'none';
      dropdown.hidden = !willOpen;
      dropdown.style.display = willOpen ? 'block' : 'none';
      toggleNotificationPanel(false);
    };

    // Setup Notification Button Click
    $('#notificationsBtn').onclick = (e) => {
      e.stopPropagation();
      toggleNotificationPanel();
    };

    // Stop propagation inside notification panel
    $('#notificationPanel').onclick = (e) => {
      e.stopPropagation();
    };

    // Global click outside listener
    document.addEventListener('click', (e) => {
      const userChip = $('#userChip');
      const userDropdown = $('#userDropdown');
      const notifBtn = $('#notificationsBtn');
      const notifPanel = $('#notificationPanel');

      if (userChip && userDropdown && !userChip.contains(e.target) && !userDropdown.contains(e.target)) {
        userDropdown.hidden = true;
        userDropdown.style.display = 'none';
      }
      if (notifBtn && notifPanel && !notifBtn.contains(e.target) && !notifPanel.contains(e.target)) {
        toggleNotificationPanel(false);
      }
    });

    // Logout button handler
    $('#logoutBtn').onclick = () => {
      handleLogout();
    };

    // 2. Initialize Real-Time WebSocket Connection
    setupWebSocket();

    // 3. Load initial dashboard data
    await Promise.all([
      loadProjects(),
      loadNotificationCount()
    ]);

    // Handle hash routing
    if (window.location.hash.startsWith('#project-')) {
      const pid = window.location.hash.replace('#project-', '');
      if (pid) openProject(pid);
    }
  } catch (err) {
    console.error('Initialization error:', err);
    handleLogout();
  }
}

// Real-time WebSockets setup
function setupWebSocket() {
  if (socket) socket.disconnect();

  socket = io({
    auth: { token }
  });

  socket.on('connect', () => {
    $('#liveStatus').querySelector('.live-label').textContent = 'Live';
    $('#liveStatus').style.display = 'flex';
  });

  socket.on('disconnect', () => {
    $('#liveStatus').querySelector('.live-label').textContent = 'Offline';
  });

  // When a project has changes (task created, updated, drag & drop, member added)
  socket.on('project:changed', async (data) => {
    if (currentProject && data.projectId == currentProject.id) {
      await refreshCurrentProjectData();
    }
    if (!$('#projectsView').hidden) {
      await loadProjects(true);
    }
  });

  // When a project is deleted
  socket.on('project:deleted', (data) => {
    if (currentProject && data.projectId == currentProject.id) {
      showToast('This project has been deleted by its owner.', 'info');
      navigateToProjectsView();
    }
    loadProjects(true);
  });

  // Real-time comment event for task discussions
  socket.on('comment:new', (data) => {
    if (currentProject && data.projectId == currentProject.id) {
      if (currentTask && currentTask.id == data.taskId) {
        appendCommentToFeed(data.comment);
      }
      const card = $(`[data-task-id="${data.taskId}"]`);
      if (card) {
        const commentCountEl = card.querySelector('.comments-count-num');
        if (commentCountEl) {
          const currentCount = parseInt(commentCountEl.textContent, 10) || 0;
          commentCountEl.textContent = currentCount + 1;
        }
      }
    }
  });

  // Incoming Notification Event
  socket.on('notification', (notification) => {
    showToast(notification.message, 'info');
    loadNotificationCount();
    const panel = $('#notificationPanel');
    if (panel && !panel.hidden && panel.style.display !== 'none') {
      loadNotifications();
    }
  });
}

// ==========================================================================
// Projects Dashboard Management
// ==========================================================================

async function loadProjects(silent = false) {
  try {
    allProjects = await api('/api/projects');
    renderProjects(allProjects);
    updateDashboardStats(allProjects);
  } catch (err) {
    if (!silent) showToast(err.message, 'error');
  }
}

function updateDashboardStats(projects) {
  const totalProjects = projects.length;
  let totalTasks = 0;
  let totalDone = 0;

  projects.forEach((p) => {
    totalTasks += Number(p.task_count) || 0;
    totalDone += Number(p.done_count) || 0;
  });

  const completionRate = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;

  $('#statProjectsCount').textContent = totalProjects;
  $('#statTasksCount').textContent = totalTasks;
  $('#statDoneCount').textContent = totalDone;
  $('#statCompletionRate').textContent = `${completionRate}%`;
  $('#projectCountBadge').textContent = `${totalProjects} Project${totalProjects === 1 ? '' : 's'}`;
}

function renderProjects(projects) {
  const container = $('#projectList');
  if (!projects.length) {
    container.innerHTML = `
      <div class="empty-state-box">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="4"/>
          <path d="M7 8h10M7 12h6M7 16h8"/>
        </svg>
        <h3>No projects yet</h3>
        <p>Create your first group workspace to start organizing tasks and collaborating with your team.</p>
        <button class="btn btn-primary" onclick="document.querySelector('#newProjectBtn').click()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>Create First Project</span>
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = projects.map((p) => {
    const taskCount = Number(p.task_count) || 0;
    const doneCount = Number(p.done_count) || 0;
    const percent = taskCount > 0 ? Math.round((doneCount / taskCount) * 100) : 0;
    const color = p.color || '#6366f1';

    return `
      <article class="project-card" data-project-id="${p.id}">
        <div class="project-color-bar" style="background: ${color}"></div>
        <div class="project-card-header">
          <h3 class="project-card-title">${escapeHtml(p.name)}</h3>
          <span class="role-badge">${escapeHtml(p.role)}</span>
        </div>
        <p class="project-card-desc">${escapeHtml(p.description || 'No description provided.')}</p>

        <div class="project-card-progress">
          <div class="progress-header">
            <span>Progress</span>
            <span>${percent}%</span>
          </div>
          <div class="progress-bar-track">
            <div class="progress-bar-fill" style="width: ${percent}%; background: ${color}"></div>
          </div>
        </div>

        <div class="project-card-footer">
          <span class="project-meta-pill">${doneCount} / ${taskCount} tasks done</span>
          <span class="project-meta-pill" style="color: ${color}">● ${p.member_count || 1} member${p.member_count === 1 ? '' : 's'}</span>
        </div>
      </article>
    `;
  }).join('');

  $$('.project-card').forEach((card) => {
    card.onclick = () => openProject(card.dataset.projectId);
  });
}

// Project search filter
$('#projectSearchInput').oninput = (e) => {
  const query = e.target.value.toLowerCase().trim();
  const filtered = allProjects.filter((p) => {
    return p.name.toLowerCase().includes(query) || (p.description && p.description.toLowerCase().includes(query));
  });
  renderProjects(filtered);
};

// Create New Project Modal
$('#newProjectBtn').onclick = () => {
  const colorOptions = [
    '#6366f1', '#8b5cf6', '#ec4899', '#10b981', '#06b6d4', '#f59e0b', '#ef4444'
  ];

  const html = `
    <form id="createProjectForm">
      <div class="form-group">
        <label for="newProjName">Project Name *</label>
        <input type="text" id="newProjName" name="name" required maxlength="120" placeholder="e.g. Mobile App Redesign" autofocus>
      </div>

      <div class="form-group">
        <label for="newProjDesc">Description (optional)</label>
        <textarea id="newProjDesc" name="description" maxlength="2000" rows="3" placeholder="What is the goal of this project?"></textarea>
      </div>

      <div class="form-group">
        <label>Accent Color</label>
        <div class="color-picker-row" id="colorPickerRow">
          ${colorOptions.map((c, i) => `
            <div class="color-option ${i === 0 ? 'selected' : ''}" data-color="${c}" style="background: ${c}"></div>
          `).join('')}
        </div>
        <input type="hidden" id="selectedColor" name="color" value="${colorOptions[0]}">
      </div>

      <div class="modal-actions">
        <button type="button" class="btn btn-outline" onclick="closeGenericModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Workspace</button>
      </div>
    </form>
  `;

  openGenericModal('Create New Project', html);

  $$('#colorPickerRow .color-option').forEach((opt) => {
    opt.onclick = () => {
      $$('#colorPickerRow .color-option').forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
      $('#selectedColor').value = opt.dataset.color;
    };
  });

  $('#createProjectForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#newProjName').value.trim();
    const description = $('#newProjDesc').value.trim();
    const color = $('#selectedColor').value;

    try {
      const newProj = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, description, color })
      });
      closeGenericModal();
      showToast('Project created successfully!', 'success');
      await openProject(newProj.id);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
};

// ==========================================================================
// Kanban Board & Tasks Management
// ==========================================================================

async function openProject(projectId, quiet = false) {
  try {
    if (currentProject && socket) {
      socket.emit('project:leave', currentProject.id);
    }

    currentProject = await api(`/api/projects/${projectId}`);

    if (socket) {
      socket.emit('project:join', currentProject.id);
    }

    // Update Header Breadcrumb
    $('#crumbSep').hidden = false;
    $('#crumbCurrentProject').hidden = false;
    $('#crumbCurrentProject').textContent = currentProject.name;
    $('#crumbProjects').classList.remove('active');

    // Update Project Meta in Board View
    $('#projectTitle').textContent = currentProject.name;
    $('#projectDescription').textContent = currentProject.description || 'No description provided.';
    $('#boardColorDot').style.background = currentProject.color || '#6366f1';
    $('#boardColorDot').style.color = currentProject.color || '#6366f1';
    $('#userRoleBadge').textContent = currentProject.user_role || 'member';

    // Render Members Avatars Stack
    renderBoardMembersStack(currentProject.members);

    // Switch Views
    $('#projectsView').hidden = true;
    $('#boardView').hidden = false;

    // Reset filters
    taskFilter = { search: '', assignee: 'all', priority: 'all' };
    $('#taskSearchInput').value = '';
    $('#filterAssignee').value = 'all';
    $('#filterPriority').value = 'all';

    // Populate filter assignee dropdown
    populateAssigneeFilter(currentProject.members);

    // Render Kanban Board
    renderBoard();

    if (!quiet) {
      window.history.replaceState({}, '', `#project-${currentProject.id}`);
    }
  } catch (err) {
    showToast(err.message, 'error');
    navigateToProjectsView();
  }
}

async function refreshCurrentProjectData() {
  if (!currentProject) return;
  try {
    const updated = await api(`/api/projects/${currentProject.id}`);
    currentProject = updated;
    renderBoardMembersStack(currentProject.members);
    renderBoard();
  } catch (err) {
    console.warn('Failed to refresh project data:', err);
  }
}

function renderBoardMembersStack(members = []) {
  const container = $('#boardMembersAvatars');
  const maxDisplay = 4;
  const displayMembers = members.slice(0, maxDisplay);
  const remaining = members.length - maxDisplay;

  container.innerHTML = displayMembers.map((m) => `
    <span class="cluster-avatar" style="background: ${m.avatar_color || '#6366f1'}" title="${escapeHtml(m.name)} (${escapeHtml(m.role)})">
      ${getUserInitials(m.name)}
    </span>
  `).join('') + (remaining > 0 ? `
    <span class="cluster-avatar" style="background: #334155" title="${remaining} more members">+${remaining}</span>
  ` : '');
}

function populateAssigneeFilter(members = []) {
  const select = $('#filterAssignee');
  select.innerHTML = `
    <option value="all">All Members</option>
    <option value="me">Assigned to Me</option>
    <option value="unassigned">Unassigned</option>
    ${members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}
  `;
}

function navigateToProjectsView() {
  if (currentProject && socket) {
    socket.emit('project:leave', currentProject.id);
  }
  currentProject = null;
  $('#crumbSep').hidden = true;
  $('#crumbCurrentProject').hidden = true;
  $('#crumbProjects').classList.add('active');
  $('#boardView').hidden = true;
  $('#projectsView').hidden = false;
  window.history.replaceState({}, '', ' ');
  loadProjects();
}

$('#backBtn').onclick = navigateToProjectsView;
$('#crumbProjects').onclick = navigateToProjectsView;
$('#brandLogo').onclick = (e) => {
  e.preventDefault();
  navigateToProjectsView();
};

$('#taskSearchInput').oninput = (e) => {
  taskFilter.search = e.target.value.toLowerCase().trim();
  renderBoard();
};

$('#filterAssignee').onchange = (e) => {
  taskFilter.assignee = e.target.value;
  renderBoard();
};

$('#filterPriority').onchange = (e) => {
  taskFilter.priority = e.target.value;
  renderBoard();
};

// ==========================================================================
// Kanban Board Rendering & Drag & Drop
// ==========================================================================

const COLUMNS = [
  { key: 'todo', label: 'To Do', indicatorClass: 'col-indicator-todo' },
  { key: 'in_progress', label: 'In Progress', indicatorClass: 'col-indicator-inprogress' },
  { key: 'review', label: 'Under Review', indicatorClass: 'col-indicator-review' },
  { key: 'done', label: 'Done', indicatorClass: 'col-indicator-done' }
];

function renderBoard() {
  if (!currentProject) return;

  const allTasks = currentProject.tasks || [];

  const filteredTasks = allTasks.filter((t) => {
    if (taskFilter.search) {
      const matchTitle = t.title.toLowerCase().includes(taskFilter.search);
      const matchDesc = t.description && t.description.toLowerCase().includes(taskFilter.search);
      if (!matchTitle && !matchDesc) return false;
    }
    if (taskFilter.assignee === 'me') {
      if (t.assignee_id !== currentUser.id) return false;
    } else if (taskFilter.assignee === 'unassigned') {
      if (t.assignee_id) return false;
    } else if (taskFilter.assignee !== 'all') {
      if (t.assignee_id != taskFilter.assignee) return false;
    }
    if (taskFilter.priority !== 'all') {
      if (t.priority !== taskFilter.priority) return false;
    }
    return true;
  });

  const totalCount = allTasks.length;
  const doneCount = allTasks.filter((t) => t.status === 'done').length;
  const percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  $('#boardProgressText').textContent = `${doneCount} of ${totalCount} completed (${percent}%)`;
  $('#boardProgressBar').style.width = `${percent}%`;

  const boardEl = $('#board');

  boardEl.innerHTML = COLUMNS.map((col) => {
    const colTasks = filteredTasks.filter((t) => t.status === col.key);

    return `
      <section class="kanban-column" data-status="${col.key}">
        <div class="column-header">
          <div class="column-title-group">
            <span class="col-indicator ${col.indicatorClass}"></span>
            <h3 class="column-title">${col.label}</h3>
            <span class="column-count">${colTasks.length}</span>
          </div>
          <button type="button" class="column-add-btn" title="Add task to ${col.label}" data-add-to-status="${col.key}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>

        <div class="column-task-list" data-column-status="${col.key}">
          ${colTasks.map((t) => renderTaskCard(t)).join('')}
        </div>
      </section>
    `;
  }).join('');

  setupKanbanDragAndDrop();

  $$('.column-add-btn').forEach((btn) => {
    btn.onclick = () => openCreateTaskModal(btn.dataset.addToStatus);
  });
}

function renderTaskCard(task) {
  const isOverdue = task.due_date && new Date(task.due_date) < new Date() && task.status !== 'done';
  const formattedDueDate = task.due_date ? new Date(task.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  const priorityClass = `priority-${task.priority || 'medium'}`;

  return `
    <article class="task-card" draggable="true" data-task-id="${task.id}" data-status="${task.status}">
      <div class="task-card-top">
        <span class="priority-pill ${priorityClass}">${task.priority || 'medium'}</span>
      </div>

      <h4 class="task-card-title">${escapeHtml(task.title)}</h4>
      ${task.description ? `<p class="task-card-desc">${escapeHtml(task.description)}</p>` : ''}

      <div class="task-card-footer">
        <div class="task-indicators">
          ${formattedDueDate ? `
            <span class="due-badge ${isOverdue ? 'overdue' : ''}" title="${isOverdue ? 'Overdue!' : 'Due Date'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>
              <span>${formattedDueDate}</span>
            </span>
          ` : ''}

          <span class="comments-badge" title="Comments">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span class="comments-count-num">${task.comment_count || 0}</span>
          </span>
        </div>

        <div class="task-assignee-wrap">
          ${task.assignee_id ? `
            <span class="assignee-avatar-chip" style="background: ${task.assignee_avatar_color || '#6366f1'}" title="Assigned to ${escapeHtml(task.assignee_name)}">
              ${getUserInitials(task.assignee_name)}
            </span>
          ` : `
            <span class="unassigned-avatar-chip" title="Unassigned">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </span>
          `}
        </div>
      </div>
    </article>
  `;
}

// Drag & Drop Implementation
let draggedTaskId = null;
let draggedSourceStatus = null;

function setupKanbanDragAndDrop() {
  const cards = $$('.task-card');
  const columns = $$('.kanban-column');

  cards.forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      draggedTaskId = card.dataset.taskId;
      draggedSourceStatus = card.dataset.status;
      card.classList.add('is-dragging');
      e.dataTransfer.setData('text/plain', draggedTaskId);
      e.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      draggedTaskId = null;
      draggedSourceStatus = null;
      columns.forEach((c) => c.classList.remove('drag-over'));
    });

    card.onclick = (e) => {
      if (card.classList.contains('is-dragging')) return;
      const taskId = card.dataset.taskId;
      const task = currentProject.tasks.find((t) => t.id == taskId);
      if (task) openTaskDetailModal(task);
    };
  });

  columns.forEach((column) => {
    column.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      column.classList.add('drag-over');
    });

    column.addEventListener('dragleave', (e) => {
      if (!column.contains(e.relatedTarget)) {
        column.classList.remove('drag-over');
      }
    });

    column.addEventListener('drop', async (e) => {
      e.preventDefault();
      column.classList.remove('drag-over');
      const targetStatus = column.dataset.status;

      if (!draggedTaskId || targetStatus === draggedSourceStatus) {
        return;
      }

      const taskId = draggedTaskId;
      const task = currentProject.tasks.find((t) => t.id == taskId);
      if (!task) return;

      const previousStatus = task.status;
      task.status = targetStatus;
      renderBoard();

      try {
        await api(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: targetStatus })
        });
        showToast(`Moved to ${targetStatus.replace('_', ' ')}`, 'info');
      } catch (err) {
        task.status = previousStatus;
        renderBoard();
        showToast('Failed to move task: ' + err.message, 'error');
      }
    });
  });
}

// Add Task Button (Header)
$('#newTaskBtn').onclick = () => openCreateTaskModal('todo');

function openCreateTaskModal(defaultStatus = 'todo') {
  if (!currentProject) return;

  const memberOptions = `
    <option value="">Unassigned</option>
    ${currentProject.members.map((m) => `
      <option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.email)})</option>
    `).join('')}
  `;

  const html = `
    <form id="createTaskForm">
      <div class="form-group">
        <label for="newTaskTitle">Task Title *</label>
        <input type="text" id="newTaskTitle" name="title" required maxlength="180" placeholder="e.g. Implement user authentication" autofocus>
      </div>

      <div class="form-group">
        <label for="newTaskDesc">Description (optional)</label>
        <textarea id="newTaskDesc" name="description" rows="3" placeholder="Provide context, acceptance criteria, or details..."></textarea>
      </div>

      <div class="form-row">
        <div class="form-group col-half">
          <label for="newTaskStatus">Status</label>
          <select id="newTaskStatus" name="status" class="form-select">
            <option value="todo" ${defaultStatus === 'todo' ? 'selected' : ''}>📋 To Do</option>
            <option value="in_progress" ${defaultStatus === 'in_progress' ? 'selected' : ''}>⚡ In Progress</option>
            <option value="review" ${defaultStatus === 'review' ? 'selected' : ''}>🔍 Under Review</option>
            <option value="done" ${defaultStatus === 'done' ? 'selected' : ''}>✅ Done</option>
          </select>
        </div>

        <div class="form-group col-half">
          <label for="newTaskPriority">Priority</label>
          <select id="newTaskPriority" name="priority" class="form-select">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
            <option value="urgent">🔥 Urgent</option>
          </select>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group col-half">
          <label for="newTaskAssignee">Assignee</label>
          <select id="newTaskAssignee" name="assigneeId" class="form-select">
            ${memberOptions}
          </select>
        </div>

        <div class="form-group col-half">
          <label for="newTaskDueDate">Due Date</label>
          <input type="date" id="newTaskDueDate" name="dueDate" class="form-input">
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn btn-outline" onclick="closeGenericModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Task</button>
      </div>
    </form>
  `;

  openGenericModal('Create New Task', html);

  $('#createTaskForm').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#newTaskTitle').value.trim();
    const description = $('#newTaskDesc').value.trim() || null;
    const status = $('#newTaskStatus').value;
    const priority = $('#newTaskPriority').value;
    const assigneeId = $('#newTaskAssignee').value ? Number($('#newTaskAssignee').value) : null;
    const dueDate = $('#newTaskDueDate').value || null;

    try {
      await api(`/api/projects/${currentProject.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title, description, status, priority, assigneeId, dueDate })
      });
      closeGenericModal();
      showToast('Task created successfully!', 'success');
      await refreshCurrentProjectData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
}

// ==========================================================================
// Task Details & Real-Time Comments Discussion Modal
// ==========================================================================

async function openTaskDetailModal(task) {
  currentTask = task;
  const modal = $('#taskModal');

  $('#taskModalId').textContent = `#${task.id}`;
  const priorityBadge = $('#taskModalPriorityBadge');
  priorityBadge.textContent = (task.priority || 'medium').toUpperCase();
  priorityBadge.className = `badge priority-${task.priority || 'medium'}`;

  $('#taskModalTitle').value = task.title;
  $('#taskModalDescription').value = task.description || '';
  $('#taskModalStatus').value = task.status || 'todo';
  $('#taskModalPriority').value = task.priority || 'medium';
  $('#taskModalDueDate').value = task.due_date ? task.due_date.slice(0, 10) : '';

  const assigneeSelect = $('#taskModalAssignee');
  assigneeSelect.innerHTML = `
    <option value="">Unassigned</option>
    ${currentProject.members.map((m) => `
      <option value="${m.id}" ${task.assignee_id == m.id ? 'selected' : ''}>
        ${escapeHtml(m.name)}
      </option>
    `).join('')}
  `;

  $('#commentsList').innerHTML = '<div class="comments-empty"><p>Loading comments...</p></div>';
  $('#commentInput').value = '';

  modal.showModal();

  try {
    const comments = await api(`/api/tasks/${task.id}/comments`);
    renderComments(comments);
  } catch (err) {
    $('#commentsList').innerHTML = `<p class="comments-empty">Failed to load comments: ${escapeHtml(err.message)}</p>`;
  }
}

function renderComments(comments = []) {
  const container = $('#commentsList');
  $('#commentsCountBadge').textContent = comments.length;

  if (!comments.length) {
    container.innerHTML = `
      <div class="comments-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <p>No comments yet. Start the conversation!</p>
      </div>
    `;
    return;
  }

  container.innerHTML = comments.map((c) => `
    <div class="comment-bubble" data-comment-id="${c.id}">
      <span class="comment-avatar" style="background: ${c.user_avatar_color || '#6366f1'}">
        ${getUserInitials(c.user_name)}
      </span>
      <div class="comment-body">
        <div class="comment-head">
          <span class="comment-author">${escapeHtml(c.user_name)}</span>
          <span class="comment-date">${formatRelativeTime(c.created_at)}</span>
        </div>
        <div class="comment-text">${escapeHtml(c.content)}</div>
      </div>
    </div>
  `).join('');

  container.scrollTop = container.scrollHeight;
}

function appendCommentToFeed(comment) {
  const container = $('#commentsList');
  const empty = container.querySelector('.comments-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'comment-bubble';
  el.innerHTML = `
    <span class="comment-avatar" style="background: ${comment.user_avatar_color || '#6366f1'}">
      ${getUserInitials(comment.user_name)}
    </span>
    <div class="comment-body">
      <div class="comment-head">
        <span class="comment-author">${escapeHtml(comment.user_name)}</span>
        <span class="comment-date">Just now</span>
      </div>
      <div class="comment-text">${escapeHtml(comment.content)}</div>
    </div>
  `;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;

  const countBadge = $('#commentsCountBadge');
  const count = parseInt(countBadge.textContent, 10) || 0;
  countBadge.textContent = count + 1;
}

function closeTaskModal() {
  $('#taskModal').close();
  currentTask = null;
}

$('#taskModalCloseBtn').onclick = closeTaskModal;

$('#taskDetailsForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!currentTask) return;

  const updates = {
    title: $('#taskModalTitle').value.trim(),
    description: $('#taskModalDescription').value.trim() || null,
    status: $('#taskModalStatus').value,
    priority: $('#taskModalPriority').value,
    assigneeId: $('#taskModalAssignee').value ? Number($('#taskModalAssignee').value) : null,
    dueDate: $('#taskModalDueDate').value || null
  };

  try {
    await api(`/api/tasks/${currentTask.id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
    showToast('Task updated successfully!', 'success');
    closeTaskModal();
    await refreshCurrentProjectData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

$('#addCommentForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!currentTask) return;

  const input = $('#commentInput');
  const content = input.value.trim();
  if (!content) return;

  try {
    const comment = await api(`/api/tasks/${currentTask.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    input.value = '';
    appendCommentToFeed(comment);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

$('#commentInput').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#addCommentForm').dispatchEvent(new Event('submit'));
  }
};

$('#deleteTaskBtn').onclick = async () => {
  if (!currentTask) return;
  if (!confirm(`Are you sure you want to delete "${currentTask.title}"?`)) return;

  try {
    await api(`/api/tasks/${currentTask.id}`, { method: 'DELETE' });
    showToast('Task deleted.', 'info');
    closeTaskModal();
    await refreshCurrentProjectData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ==========================================================================
// Project Members Management Modal
// ==========================================================================

$('#membersBtn').onclick = () => {
  if (!currentProject) return;

  const isOwner = currentProject.user_role === 'owner';

  const html = `
    <div class="members-modal-content">
      <div class="members-list-wrapper">
        <label>Current Members (${currentProject.members.length})</label>
        ${currentProject.members.map((m) => `
          <div class="member-row-card">
            <div class="member-row-left">
              <span class="cluster-avatar" style="background: ${m.avatar_color || '#6366f1'}">
                ${getUserInitials(m.name)}
              </span>
              <div class="member-row-info">
                <strong>${escapeHtml(m.name)} ${m.id === currentUser.id ? '<small>(You)</small>' : ''}</strong>
                <small>${escapeHtml(m.email)}</small>
              </div>
            </div>
            <div class="member-row-right">
              <span class="role-badge">${m.role}</span>
              ${isOwner && m.role !== 'owner' ? `
                <button type="button" class="btn btn-sm btn-danger remove-member-btn" data-user-id="${m.id}" title="Remove member">
                  Remove
                </button>
              ` : ''}
            </div>
          </div>
        `).join('')}
      </div>

      ${isOwner ? `
        <div class="invite-member-section" style="border-top: 1px solid var(--border-subtle); padding-top: 18px;">
          <label>Invite Teammate by Email</label>
          <form id="inviteMemberForm" style="display:flex; gap:10px; margin-top:8px;">
            <input type="email" id="inviteMemberEmail" required placeholder="teammate@example.com" class="form-input">
            <button type="submit" class="btn btn-primary btn-sm">Invite</button>
          </form>
          <small style="color:var(--text-faint); margin-top:6px; display:block;">
            User must already be registered with ProjectFlow.
          </small>
        </div>
      ` : ''}

      <div class="modal-actions" style="margin-top: 20px;">
        <button type="button" class="btn btn-outline" onclick="closeGenericModal()">Done</button>
      </div>
    </div>
  `;

  openGenericModal(`Project Members · ${currentProject.name}`, html);

  if (isOwner) {
    $('#inviteMemberForm').onsubmit = async (e) => {
      e.preventDefault();
      const email = $('#inviteMemberEmail').value.trim();
      if (!email) return;

      try {
        await api(`/api/projects/${currentProject.id}/members`, {
          method: 'POST',
          body: JSON.stringify({ email })
        });
        showToast('Member invited successfully!', 'success');
        closeGenericModal();
        await refreshCurrentProjectData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    $$('.remove-member-btn').forEach((btn) => {
      btn.onclick = async () => {
        const userId = btn.dataset.userId;
        if (!confirm('Are you sure you want to remove this member?')) return;

        try {
          await api(`/api/projects/${currentProject.id}/members/${userId}`, {
            method: 'DELETE'
          });
          showToast('Member removed.', 'info');
          closeGenericModal();
          await refreshCurrentProjectData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    });
  }
};

// ==========================================================================
// Project Settings Modal (Owner Only)
// ==========================================================================

$('#projectSettingsBtn').onclick = () => {
  if (!currentProject) return;

  const isOwner = currentProject.user_role === 'owner';
  const colorOptions = ['#6366f1', '#8b5cf6', '#ec4899', '#10b981', '#06b6d4', '#f59e0b', '#ef4444'];

  const html = `
    <form id="editProjectForm">
      <div class="form-group">
        <label for="editProjName">Project Name</label>
        <input type="text" id="editProjName" value="${escapeHtml(currentProject.name)}" required maxlength="120" ${!isOwner ? 'disabled' : ''}>
      </div>

      <div class="form-group">
        <label for="editProjDesc">Description</label>
        <textarea id="editProjDesc" rows="3" maxlength="2000" ${!isOwner ? 'disabled' : ''}>${escapeHtml(currentProject.description || '')}</textarea>
      </div>

      ${isOwner ? `
        <div class="form-group">
          <label>Theme Color</label>
          <div class="color-picker-row" id="editColorPickerRow">
            ${colorOptions.map((c) => `
              <div class="color-option ${currentProject.color === c ? 'selected' : ''}" data-color="${c}" style="background: ${c}"></div>
            `).join('')}
          </div>
          <input type="hidden" id="editSelectedColor" value="${currentProject.color || colorOptions[0]}">
        </div>

        <div class="danger-zone" style="border-top:1px solid rgba(239, 68, 68, 0.2); padding-top:18px; margin-top:20px;">
          <label style="color:#f87171;">Danger Zone</label>
          <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:10px;">
            Permanently delete this project and all its tasks, boards, and comments.
          </p>
          <button type="button" class="btn btn-danger btn-sm" id="deleteProjectBtn">
            Delete Project
          </button>
        </div>
      ` : ''}

      <div class="modal-actions">
        <button type="button" class="btn btn-outline" onclick="closeGenericModal()">Cancel</button>
        ${isOwner ? '<button type="submit" class="btn btn-primary">Save Changes</button>' : ''}
      </div>
    </form>
  `;

  openGenericModal('Project Settings', html);

  if (isOwner) {
    $$('#editColorPickerRow .color-option').forEach((opt) => {
      opt.onclick = () => {
        $$('#editColorPickerRow .color-option').forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        $('#editSelectedColor').value = opt.dataset.color;
      };
    });

    $('#editProjectForm').onsubmit = async (e) => {
      e.preventDefault();
      const name = $('#editProjName').value.trim();
      const description = $('#editProjDesc').value.trim();
      const color = $('#editSelectedColor').value;

      try {
        await api(`/api/projects/${currentProject.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, description, color })
        });
        showToast('Project updated.', 'success');
        closeGenericModal();
        await refreshCurrentProjectData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    $('#deleteProjectBtn').onclick = async () => {
      if (!confirm(`Are you sure you want to permanently delete "${currentProject.name}"? This cannot be undone.`)) {
        return;
      }
      try {
        await api(`/api/projects/${currentProject.id}`, { method: 'DELETE' });
        closeGenericModal();
        showToast('Project deleted.', 'info');
        navigateToProjectsView();
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
  }
};

// ==========================================================================
// Notifications System
// ==========================================================================

function toggleNotificationPanel(forceState) {
  const panel = $('#notificationPanel');
  const btn = $('#notificationsBtn');
  if (!panel || !btn) return;

  const isCurrentlyClosed = panel.hidden || panel.style.display === 'none';
  const willOpen = forceState !== undefined ? forceState : isCurrentlyClosed;

  if (willOpen) {
    panel.hidden = false;
    panel.style.display = 'flex';
    btn.classList.add('active');
    const userDropdown = $('#userDropdown');
    if (userDropdown) {
      userDropdown.hidden = true;
      userDropdown.style.display = 'none';
    }
    loadNotifications();
  } else {
    panel.hidden = true;
    panel.style.display = 'none';
    btn.classList.remove('active');
  }
}

async function loadNotificationCount() {
  if (!token) return;
  try {
    const list = await api('/api/notifications');
    const unread = list.filter((n) => !n.is_read || n.is_read === 0 || n.is_read === '0').length;
    const badge = $('#notificationBadge');
    if (!badge) return;

    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : unread;
      badge.hidden = false;
      badge.style.display = 'flex';
    } else {
      badge.hidden = true;
      badge.style.display = 'none';
      badge.textContent = '0';
    }
  } catch (err) {
    console.warn('Failed to load notification count:', err);
  }
}

async function loadNotifications() {
  if (!token) return;
  const listEl = $('#notificationList');
  if (!listEl) return;

  try {
    const items = await api('/api/notifications');
    if (!items.length) {
      listEl.innerHTML = `
        <div class="empty-notifications">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          <p>No notifications yet</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = items.map((n) => `
      <div class="notification-item ${(!n.is_read || n.is_read === 0) ? 'unread' : ''}" data-notification-id="${n.id}" data-link="${n.link || ''}">
        <span class="notification-msg">${escapeHtml(n.message)}</span>
        <span class="notification-time">${formatRelativeTime(n.created_at)}</span>
      </div>
    `).join('');

    $$('.notification-item').forEach((item) => {
      item.onclick = async (e) => {
        e.stopPropagation();
        const id = item.dataset.notificationId;
        const link = item.dataset.link;
        try {
          await api(`/api/notifications/${id}/read`, { method: 'PATCH' });
          item.classList.remove('unread');
          await loadNotificationCount();
          toggleNotificationPanel(false);
          if (link && link.startsWith('/project/')) {
            const projectId = link.replace('/project/', '');
            await openProject(projectId);
          }
        } catch (err) {
          console.warn(err);
        }
      };
    });
  } catch (err) {
    listEl.innerHTML = `<p class="empty-notifications">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

$('#markAllReadBtn').onclick = async (e) => {
  e.stopPropagation();
  try {
    await api('/api/notifications/mark-all-read', { method: 'POST' });
    showToast('All notifications marked as read', 'info');
    await Promise.all([loadNotifications(), loadNotificationCount()]);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ==========================================================================
// Initialization on Page Load
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  setupAuth();
  if (token) {
    initializeApp();
  } else {
    $('#authView').hidden = false;
    $('#appView').hidden = true;
  }
});
