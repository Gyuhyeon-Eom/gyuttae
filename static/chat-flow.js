'use strict';
// Shared, DOM-free rules for grouping and retrying messages.
const ChatFlow = (() => {
  function grouped(previous, current) {
    return !!previous && previous.status === 'message' && current.status === 'message'
      && previous.author_id === current.author_id && !!current.author_id
      && previous.room === current.room
      && !previous.deliveryError && !current.deliveryError
      && current.created >= previous.created && current.created - previous.created < 120
      && new Date(previous.created * 1000).toDateString() === new Date(current.created * 1000).toDateString();
  }
  function merge(turns, entries, room, author) {
    const ids = new Set(turns.map(t => t.id));
    return [...turns, ...entries.filter(e => e.room === room && !ids.has(e.body.request_id)).map(e => ({
      id: e.body.request_id, room:e.room, author_id:e.uid, author, mine:true,
      text:e.body.text, has_image:!!e.body.image, localImage:e.body.image ? `data:${e.body.image_type};base64,${e.body.image}` : null,
      created:e.created, status:'message', delivery:e.delivery, deliveryError:e.error, local:true
    }))].sort((a,b) => a.created-b.created);
  }
  class Queue {
    constructor({send,changed,accepted}) { Object.assign(this,{send,changed,accepted,entries:[],active:new Set()}); }
    add(entry) { this.entries.push(entry); this.changed(); }
    confirm(turns) { const ids=new Set(turns.map(t=>t.id));const count=this.entries.length;this.entries=this.entries.filter(e=>!ids.has(e.body.request_id));if(count!==this.entries.length)this.changed(); }
    async retry(id) {
      const entry=this.entries.find(e=>e.body.request_id===id);
      if(!entry||this.active.has(id))return;
      this.active.add(id);entry.delivery='sending';entry.error='';this.changed();
      let turn;
      try { turn=await this.send(entry); }
      catch(error) {
        if(this.entries.includes(entry)){entry.delivery='failed';entry.error=error.message;this.changed();}
        return;
      } finally { this.active.delete(id); }
      this.entries=this.entries.filter(e=>e!==entry);this.changed();this.accepted(turn,entry);
    }
  }
  return {grouped,merge,Queue};
})();
