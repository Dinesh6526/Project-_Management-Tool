const fs = require('fs');
const appJs = fs.readFileSync('frontend/app.js', 'utf8');
const indexHtml = fs.readFileSync('frontend/index.html', 'utf8');

// Match $('#...')
const idRegex = /\$\(['"]#([a-zA-Z0-9_-]+)['"]\)/g;
let match;
const usedIds = new Set();
while ((match = idRegex.exec(appJs)) !== null) {
  usedIds.add(match[1]);
}

const missing = [];
const dynamicInModals = [
  'newProjName', 'newProjDesc', 'colorPickerRow', 'selectedColor', 'createProjectForm',
  'newTaskTitle', 'newTaskDesc', 'newTaskStatus', 'newTaskPriority', 'newTaskAssignee', 'newTaskDueDate', 'createTaskForm',
  'inviteMemberEmail', 'inviteMemberForm',
  'editProjName', 'editProjDesc', 'editColorPickerRow', 'editSelectedColor', 'editProjectForm', 'deleteProjectBtn'
];

for (const id of usedIds) {
  if (!indexHtml.includes('id="' + id + '"') && !indexHtml.includes("id='" + id + "'")) {
    if (!dynamicInModals.includes(id)) {
      missing.push(id);
    }
  }
}

console.log('Total unique IDs referenced:', usedIds.size);
console.log('Missing static IDs from index.html (excluding dynamic modal fields):', missing);
