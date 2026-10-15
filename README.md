# ProjectFlow — Collaborative Project Management Tool

A modern, full-stack collaborative project management application inspired by **Trello** and **Asana**. Built with **Vanilla JavaScript**, **Express.js**, **MySQL**, **JWT Authentication**, and **Socket.IO** for real-time WebSockets synchronization.

---

## Key Features

### 1. Collaborative Group Projects
- **Workspaces & Projects**: Create, edit, and organize group projects with custom color themes.
- **Role-Based Access**: Project owners can manage settings, invite members by registered email, and assign roles (`owner`, `member`).
- **Dashboard Metrics**: Live overview of total projects, active tasks, completed tasks, and completion rate progress bars.

### 2. Trello-Style Drag-and-Drop Kanban Boards
- **4 Workflow Stages**:
  - `📋 To Do`
  - `⚡ In Progress`
  - `🔍 Under Review`
  - `✅ Done`
- **Native HTML5 Drag & Drop**: Smoothly drag task cards between columns with immediate visual feedback and real-time backend persistence.
- **Board Filters**: Search tasks by keyword, filter by assignee ("Assigned to Me", "All Members", "Unassigned"), or filter by priority.

### 3. Rich Task Cards & Assignments
- **Assignees**: Assign tasks to any project member; cards display member avatar chips and tooltips.
- **Priority Badges**: Visual indicators for `🔥 Urgent`, `High`, `Medium`, and `Low` priorities.
- **Due Dates & Overdue Alerts**: Calendar date picker with red warnings for overdue items.
- **Task Management**: Full task edit and deletion capabilities.

### 4. Real-Time Task Discussions & Comments
- **In-Task Communication**: Open any task card to access a dedicated discussion thread.
- **Real-Time Broadcast**: Comments appear instantly across all connected teammates' browsers without page refreshes via WebSockets.
- **Activity Feed**: Displays author avatars, names, relative timestamps ("Just now", "2m ago"), and message history.

### 5. WebSockets Real-Time Updates & Notifications
- **Instant Synchronization**: When any teammate creates, updates, moves, or deletes a task, connected boards update live.
- **Notification Bell**: Live unread badge count, dropdown panel with recent notifications (assignments, comments, project invitations).
- **Interactive Toasts**: Animated alert banners for real-time events.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla HTML5, Modern CSS (Glassmorphism, Dark Slate Theme), Vanilla JavaScript (ES6+), Google Fonts (Plus Jakarta Sans & Inter) |
| **Backend** | Node.js, Express.js |
| **Real-Time** | Socket.IO WebSockets |
| **Database** | MySQL 8.0+ (mysql2/promise with connection pooling & auto-migration) |
| **Security** | JSON Web Tokens (JWT), Bcrypt password hashing (cost factor 12), express-rate-limit, express-validator |

---

## Getting Started

### Prerequisites
- **Node.js** (v18 or higher)
- **MySQL Server** (v8.0+ running locally or remotely)

### 1. Configure Environment Variables
Verify or create a `.env` file in the project root:

```env
PORT=3000
CLIENT_ORIGIN=http://localhost:3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=projectflow
JWT_SECRET=ProjectFlowSecureDevSecretKey2026
JWT_EXPIRES_IN=8h
```

### 2. Database Setup & Auto-Migration
The backend automatically runs schema migrations on startup to create or update all tables and columns (`priority`, `avatar_color`, `color`, etc.).

Alternatively, you can manually run:
```bash
node backend/migrate.js
```

### 3. Run the Application
Install dependencies (if not already installed) and start the server:

```bash
# Install dependencies
npm install

# Start production/local server
npm start

# Or start in development mode with auto-reload
npm run dev
```

Visit **http://localhost:3000** in your web browser.

---

You can register an account with an email and password (minimum 6 characters).

---

## API Reference

### Authentication
- `POST /api/auth/register` — Register a new account (`name`, `email`, `password`)
- `POST /api/auth/login` — Sign in and receive JWT token (`email`, `password`)
- `GET /api/auth/me` — Retrieve current authenticated user profile
- `GET /api/users/search?q=...` — Search registered users by name or email

### Projects
- `GET /api/projects` — List all projects for current user
- `POST /api/projects` — Create a new project (`name`, `description`, `color`)
- `GET /api/projects/:id` — Get project details, members, and task list
- `PATCH /api/projects/:id` — Update project settings (owner only)
- `DELETE /api/projects/:id` — Delete project and its tasks (owner only)
- `POST /api/projects/:id/members` — Invite a teammate by email (owner only)
- `DELETE /api/projects/:id/members/:userId` — Remove a project member

### Tasks
- `POST /api/projects/:id/tasks` — Create a new task card
- `GET /api/tasks/:id` — Fetch task details with comments
- `PATCH /api/tasks/:id` — Update task (`title`, `description`, `status`, `priority`, `assigneeId`, `dueDate`)
- `DELETE /api/tasks/:id` — Delete a task card

### Comments
- `GET /api/tasks/:id/comments` — Get discussion history for a task
- `POST /api/tasks/:id/comments` — Post a comment (broadcasts in real-time)

### Notifications
- `GET /api/notifications` — Retrieve user's notification list
- `PATCH /api/notifications/:id/read` — Mark specific notification as read
- `POST /api/notifications/mark-all-read` — Mark all notifications as read
- `DELETE /api/notifications/clear` — Clear read notifications
