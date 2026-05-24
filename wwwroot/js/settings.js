window.Settings = (function(){
  let cache = null;

  async function load(){
    const res = await fetch('/api/settings');
    cache = await res.json();
    return cache;
  }

  function getCached(){ return cache; }

  async function addProject(name, directory, color){
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({name, directory, color})
    });
    if(!res.ok) throw new Error('Failed to add project');
    return await res.json();
  }

  async function updateProject(id, name, directory, color){
    const res = await fetch('/api/projects/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({name, directory, color})
    });
    if(!res.ok) throw new Error('Failed to update project');
    return await res.json();
  }

  async function deleteProject(id){
    const res = await fetch('/api/projects/' + encodeURIComponent(id), {method:'DELETE'});
    if(!res.ok) throw new Error('Failed to delete project');
  }

  async function saveButtons(config){
    const res = await fetch('/api/buttons', {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(config)
    });
    if(!res.ok) throw new Error('Failed to save buttons');
  }

  return { load, getCached, addProject, updateProject, deleteProject, saveButtons };
})();
