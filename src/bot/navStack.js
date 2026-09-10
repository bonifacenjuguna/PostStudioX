// Real cross-screen "Back" support. Each scene pushes a small, plain-data
// frame describing the screen it's leaving *before* navigating forward
// (e.g. { scene: 'channels', view: 'list' } before opening a channel's
// detail view). Tapping nav:back pops the last frame and asks that scene
// to re-render exactly that screen via its own renderFromNavFrame(ctx,
// frame) - each scene owns interpreting its own frame shape, this module
// just owns the stack itself.
//
// This is separate from in-wizard "step back" (e.g. New Post's own
// Back-to-previous-step buttons) - those are linear and belong to the
// wizard's own step machine. This stack is for backing out across
// different screens/scenes however many hops deep you've gone.

const MAX_DEPTH = 15;

function push(ctx, frame) {
  if (!ctx.session.navStack) ctx.session.navStack = [];
  ctx.session.navStack.push(frame);
  if (ctx.session.navStack.length > MAX_DEPTH) ctx.session.navStack.shift();
}

function pop(ctx) {
  if (!ctx.session.navStack || ctx.session.navStack.length === 0) return null;
  return ctx.session.navStack.pop();
}

function clear(ctx) {
  ctx.session.navStack = [];
}

module.exports = { push, pop, clear, MAX_DEPTH };
