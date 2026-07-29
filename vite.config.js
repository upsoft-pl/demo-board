import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the same build works on GitHub Pages (project path),
  // on S3, and from a plain `vite preview`.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Two entries: the editor app, and a standalone player. The editor fetches
    // player.html + its assets at runtime and repackages them as the published
    // static site, which is why the player must be a real build target.
    rollupOptions: {
      input: {
        index: 'index.html',
        player: 'player.html',
      },
    },
  },
  test: {
    // Node, not jsdom, on purpose: jsdom has no layout engine, so anything it
    // could tell us about geometry would be a lie. Geometry is asserted for
    // real in tests/e2e. This tier is pure arithmetic and stays sub-second.
    environment: 'node',
    include: ['src/**/*.test.js'],
    reporters: 'dot',
  },
});
