window.Settings = (function(){
  let cache = null;

  async function load(){
    const res = await fetch('/api/settings');
    cache = await res.json();
    if(cache.bootId){
      var prev = sessionStorage.getItem('bootId');
      if(prev && prev !== cache.bootId){
        sessionStorage.setItem('bootId', cache.bootId);
        if('caches' in window) caches.keys().then(function(k){ k.forEach(function(n){ caches.delete(n); }); });
        location.reload(true);
        return cache;
      }
      sessionStorage.setItem('bootId', cache.bootId);
    }
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
