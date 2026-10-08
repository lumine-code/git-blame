# git-blame

Show the commit that last changed each line in a gutter.

Fork of [alexcorre/git-blame](https://github.com/alexcorre/git-blame).

Consecutive lines from the same commit form one block, with its hash, date and author shown once. The label stays visible as you scroll through a long block. Clicking anywhere in the block opens that commit on the repository's hosting service, or copies its hash when there is nowhere to open it.

## Features

- **Commit attribution**: the hash, date and author shown once for each consecutive block of lines from one commit.
- **Commit banding**: blocks share a background and keep their label visible while scrolling, including wrapped lines.
- **Commit links**: GitHub, GitLab and Bitbucket are recognised, and any other host can be described with a template.
- **Author colours**: an optional stripe coloured from the author's name, stable across files and sessions.
- **Resizable**: drag the gutter's right edge to set its width.
- **Refreshes on save**: blame is re-read when the file is saved, so it does not go stale behind you.
- **Off the renderer thread**: blame is read through the editor's Git worker, so a large file does not block typing.

## Installation

To install `git-blame` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/git-blame`.

## Commands

Commands available in `lumine-workspace`:

- `git-blame:toggle`: show or hide the blame gutter for the current editor.

## Usage

The gutter reads blame for the file in the active editor, so the file has to be saved and inside a Git repository. Lines you have written but not committed are marked as such rather than left blank. When the editor refuses, it says which of those reasons applied.

Submodules need no special handling: the editor's repository registry resolves the file to the repository that actually contains it.

## Configuration

Commit links work out of the box for GitHub, GitLab and Bitbucket. For any other host, set a template using `{host}`, `{project}`, `{repo}` and `{revision}`:

```
https://git.example.com/{project}/{repo}/commit/{revision}
```

A repository can also carry its own template, which wins over the setting, so a self-hosted forge can be configured once per clone rather than per user:

```bash
git config git-blame.commitUrlTemplate "https://git.example.com/{project}/{repo}/commit/{revision}"
```

## Customization

The gutter is styled through the theme's own variables. To change how a blame line reads, paste something like this into your `styles.css`:

```css
lumine-text-editor .gutter[gutter-name="git-blame"] .git-blame-line {
  font-size: 0.9em;
  opacity: 0.8;
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
