// Full-project lint belongs in pre-commit, once per affected application.
// lint-staged still owns backup, restoration and re-staging of formatted files.
export default {
  '*.{js,ts,tsx}': (files) => {
    const prefix = 'prettier --write --';
    const maxCommandLength = 6000;
    const commands = [];
    let command = prefix;
    for (const file of files) {
      // lint-staged executes argv directly, without a shell. Normalize Windows
      // separators before quoting so spaces and apostrophes remain one argument.
      const normalized = file.replace(/\\/g, '/');
      if (/[\r\n]/.test(normalized))
        throw new Error('Prettier file paths must not contain line breaks');
      const argument = JSON.stringify(normalized);
      if (prefix.length + argument.length + 1 > maxCommandLength)
        throw new Error('Prettier file path exceeds the command length budget');
      if (command.length + argument.length + 1 > maxCommandLength) {
        commands.push(command);
        command = prefix;
      }
      command += ` ${argument}`;
    }
    if (command !== prefix) commands.push(command);
    return commands;
  },
};
