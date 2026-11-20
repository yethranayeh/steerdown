# steerdown

Typed reading paths for Markdown judged at build time

steerdown splits Markdown into sections and suggests what to read next from each one, labelled by what the link is to the reader: read before this, read next, reference detail, or another way to the same goal. The judgments are made once at build time and committed as a file. The site build needs no API key, and readers send nothing anywhere.

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
