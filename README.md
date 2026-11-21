# steerdown

Typed reading paths for built HTML judged at build time

steerdown reads the built HTML of a site, whatever built it. It splits the pages into sections and suggests what to read next from each one, labelled by what the link is to the reader: read before this, read next, reference detail, or another way to the same goal. The judgments are made once at build time and committed as a file. The site build needs no API key, and readers send nothing anywhere.

**Status: Experimental.** Commands and file formats will change.

## Install

steerdown needs Node 22 or later.

```sh
npm install --save-dev steerdown
```

## Try it

```sh
npx steerdown --help
```

## License

MIT
