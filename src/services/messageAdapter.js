// Maps a real Telegram Message object (from a forward, or fetched via
// forwardMessage) into our draft/saved_item field shape. Originally lived
// only inside Compose's Import feature; factored out here once the
// Replace-Live feature needed the exact same mapping, rather than
// duplicating it a second time.
function extractDraftFieldsFromMessage(msg) {
  const fields = { entities: msg.caption_entities || msg.entities || [] };
  if (msg.photo) {
    fields.mediaType = 'photo';
    fields.mediaItems = [{ file_id: msg.photo[msg.photo.length - 1].file_id, type: 'photo' }];
    fields.caption = msg.caption || '';
  } else if (msg.video) {
    fields.mediaType = 'video';
    fields.mediaItems = [{ file_id: msg.video.file_id, type: 'video' }];
    fields.caption = msg.caption || '';
  } else if (msg.document) {
    fields.mediaType = 'document';
    fields.mediaItems = [{ file_id: msg.document.file_id, type: 'document' }];
    fields.caption = msg.caption || '';
  } else {
    fields.mediaType = 'text';
    fields.mediaItems = [];
    fields.caption = msg.text || '';
  }
  return fields;
}

module.exports = { extractDraftFieldsFromMessage };
