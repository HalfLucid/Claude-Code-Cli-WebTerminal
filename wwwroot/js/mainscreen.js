window.MainScreen = (function(){
  let editingProjectId = null;

  async function refresh(){
    const settings = await Settings.load();
    renderProjects(settings.projects || []);
    refreshStartup();
  }

  const startupBtn = document.getElementById('btn-startup');
  let startupEnabled = false;

  async function refreshStartup(){
    try{
      const res = await fetch('/api/startup');
      const data = await res.json();
      startupEnabled = data.enabled;
      startupBtn.textContent = 'Startup: ' + (startupEnabled ? 'ON' : 'OFF');
      startupBtn.style.borderColor = startupEnabled ? '#238636' : '#30363d';
    }catch{}
  }

  startupBtn.addEventListener('click', async () => {
    const newState = !startupEnabled;
    startupBtn.textContent = 'Startup: ...';
    try{
      const res = await fetch('/api/startup', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({enabled: newState})
      });
      const data = await res.json();
      startupEnabled = data.enabled;
      startupBtn.textContent = 'Startup: ' + (startupEnabled ? 'ON' : 'OFF');
      startupBtn.style.borderColor = startupEnabled ? '#238636' : '#30363d';
    }catch{ startupBtn.textContent = 'Startup: ERR'; }
  });

  function renderProjects(projects){
    const list = document.getElementById('project-list');
    list.innerHTML = '';
    projects.forEach(p => {
      const card = document.createElement('div');
      card.className = 'project-card';
      card.style.borderLeftColor = p.color;

      const name = document.createElement('span');
      name.className = 'project-name';
      name.textContent = p.name;
      card.appendChild(name);

      const dir = document.createElement('span');
      dir.className = 'project-dir';
      dir.textContent = p.directory;
      dir.title = p.directory;
      card.appendChild(dir);

      const actions = document.createElement('div');
      actions.className = 'project-actions';

      const btnClaude = document.createElement('button');
      btnClaude.className = 'launch-btn';
      btnClaude.textContent = 'Open Claude';
      btnClaude.addEventListener('click', () => launchSession('claude', p.id, p.name, p.color));
      actions.appendChild(btnClaude);

      const btnResume = document.createElement('button');
      btnResume.className = 'launch-btn';
      btnResume.textContent = 'Resume Claude';
      btnResume.addEventListener('click', () => launchSession('claude-resume', p.id, p.name + ' (R)', p.color));
      actions.appendChild(btnResume);

      const btnEdit = document.createElement('button');
      btnEdit.className = 'project-edit-btn';
      btnEdit.innerHTML = '&#9998;';
      btnEdit.title = 'Edit';
      btnEdit.addEventListener('click', () => openEditProject(p));
      actions.appendChild(btnEdit);

      const btnDel = document.createElement('button');
      btnDel.className = 'project-delete-btn';
      btnDel.innerHTML = '&times;';
      btnDel.title = 'Delete';
      btnDel.addEventListener('click', () => deleteProject(p.id, p.name));
      actions.appendChild(btnDel);

      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function launchSession(kind, projectId, label, color, defaultCommand){
    TabManager.createTab(kind, projectId, label, color, defaultCommand);
  }

  document.getElementById('btn-back-to-session').addEventListener('click', () => {
    var active = TabManager.getActive();
    if(active){
      TabManager.hideMainScreen();
    } else if(TabManager.getAll().length > 0){
      TabManager.switchTo(0);
    }
  });

  document.getElementById('btn-add-mcp').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/mcp-setup', { method: 'POST' });
      const data = await res.json();
      const settings = Settings.getCached();
      const color = (settings && settings.defaultPowershellColor) || '#1e6f1e';
      launchSession('powershell', null, 'Add MCP', color, data.command);
    } catch(e) {
      alert('MCP setup failed: ' + e.message);
    }
  });

  document.getElementById('launch-powershell').addEventListener('click', () => {
    const settings = Settings.getCached();
    const color = (settings && settings.defaultPowershellColor) || '#1e6f1e';
    launchSession('powershell', null, 'PowerShell', color);
  });

  document.getElementById('btn-add-project').addEventListener('click', () => {
    editingProjectId = null;
    document.getElementById('project-modal-title').textContent = 'New Project';
    document.getElementById('proj-name').value = '';
    document.getElementById('proj-dir').value = '';
    document.getElementById('proj-color').value = '#4a90d9';
    document.getElementById('project-modal').classList.add('visible');
  });

  document.getElementById('proj-cancel').addEventListener('click', () => {
    document.getElementById('project-modal').classList.remove('visible');
  });

  document.getElementById('proj-save').addEventListener('click', async () => {
    const name = document.getElementById('proj-name').value.trim();
    const dir = document.getElementById('proj-dir').value.trim();
    const color = document.getElementById('proj-color').value;
    if(!name || !dir) return;

    if(editingProjectId){
      await Settings.updateProject(editingProjectId, name, dir, color);
    } else {
      await Settings.addProject(name, dir, color);
    }
    document.getElementById('project-modal').classList.remove('visible');
    refresh();
  });

  function openEditProject(p){
    editingProjectId = p.id;
    document.getElementById('project-modal-title').textContent = 'Edit Project';
    document.getElementById('proj-name').value = p.name;
    document.getElementById('proj-dir').value = p.directory;
    document.getElementById('proj-color').value = p.color;
    document.getElementById('project-modal').classList.add('visible');
  }

  async function deleteProject(id, name){
    if(!confirm('Delete project "' + name + '"?')) return;
    await Settings.deleteProject(id);
    refresh();
  }

  // Button config modal
  document.getElementById('btn-button-config').addEventListener('click', () => {
    openButtonConfig();
  });

  let tempOrder = [];
  let tempCustom = [];

  function openButtonConfig(){
    const settings = Settings.getCached();
    const btnConfig = settings?.buttons || {};
    tempOrder = [...(btnConfig.order || ButtonBar.getBuiltinKeys())].filter(k => !ButtonBar.isMinimizedOnly(k));
    tempCustom = [...(btnConfig.custom || [])];
    renderButtonConfig();
    document.getElementById('button-config-modal').classList.add('visible');
  }

  function renderButtonConfig(){
    const list = document.getElementById('btn-config-list');
    list.innerHTML = '';
    tempOrder.forEach((key, i) => {
      const item = document.createElement('div');
      item.className = 'btn-config-item';

      const label = document.createElement('span');
      label.className = 'btn-config-label';
      if(ButtonBar.isBuiltin(key)){
        label.textContent = ButtonBar.getBuiltinLabel(key) + ' (' + key + ')';
      } else {
        const custom = tempCustom.find(c => c.id === key);
        label.textContent = custom ? custom.label + ' (custom)' : key;
      }
      item.appendChild(label);

      const upBtn = document.createElement('button');
      upBtn.className = 'btn-config-move';
      upBtn.innerHTML = '&#9650;';
      upBtn.addEventListener('click', () => { moveButton(i, -1); });
      item.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.className = 'btn-config-move';
      downBtn.innerHTML = '&#9660;';
      downBtn.addEventListener('click', () => { moveButton(i, 1); });
      item.appendChild(downBtn);

      if(!ButtonBar.isBuiltin(key)){
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-config-delete';
        delBtn.innerHTML = '&times;';
        delBtn.addEventListener('click', () => { removeButton(i, key); });
        item.appendChild(delBtn);
      }

      list.appendChild(item);
    });
  }

  function moveButton(index, dir){
    const newIndex = index + dir;
    if(newIndex < 0 || newIndex >= tempOrder.length) return;
    const tmp = tempOrder[index];
    tempOrder[index] = tempOrder[newIndex];
    tempOrder[newIndex] = tmp;
    renderButtonConfig();
  }

  function removeButton(index, key){
    tempOrder.splice(index, 1);
    tempCustom = tempCustom.filter(c => c.id !== key);
    renderButtonConfig();
  }

  document.getElementById('custom-btn-add').addEventListener('click', () => {
    const label = document.getElementById('custom-btn-label').value.trim();
    const command = document.getElementById('custom-btn-command').value;
    if(!label || !command) return;
    const id = 'custom-' + Date.now();
    tempCustom.push({ id, label, command });
    tempOrder.push(id);
    document.getElementById('custom-btn-label').value = '';
    document.getElementById('custom-btn-command').value = '';
    renderButtonConfig();
  });

  document.getElementById('btn-config-save').addEventListener('click', async () => {
    const fullOrder = [...tempOrder, 'scroll-up', 'scroll-down'];
    const config = { order: fullOrder, custom: tempCustom };
    await Settings.saveButtons(config);
    ButtonBar.setConfig(fullOrder, tempCustom);
    document.getElementById('button-config-modal').classList.remove('visible');
  });

  document.getElementById('btn-config-cancel').addEventListener('click', () => {
    document.getElementById('button-config-modal').classList.remove('visible');
  });

  return { refresh };
})();
