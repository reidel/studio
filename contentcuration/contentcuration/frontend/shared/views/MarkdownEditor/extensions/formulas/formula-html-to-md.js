/**
 * Helper function that converts all formulas HTML representations
 * to markdown based on `data-formula` attribute contents.
 *
 * E.g.
 * "
 *  Solve the following set of equations:
 *    <span data-formula="3x+5y=2">...</span>,
 *    <span data-formula="5x+8y=3">...</span>
 * "
 * will be converted to
 * "
 *  Solve the following set of equations:
 *    $$3x+5y=2$$,
 *    $$5x+8y=3$$
 * "
 *
 * It's expected to handle elements which classes or child
 * elements might vary, especially MathQuill's static and editable
 * math fields (see specs for this file).
 */

export default content => {
  if (!content || !content.includes('data-formula')) {
    return content;
  }

  const domParser = new DOMParser();
  const doc = domParser.parseFromString(content, 'text/html');

  const mathFieldsEls = doc.querySelectorAll('[data-formula]');

  for (const mathFieldEl of mathFieldsEls) {
    const formula = mathFieldEl.getAttribute('data-formula');
    mathFieldEl.replaceWith('$$' + formula + '$$');
  }

  let newContent = doc.body.innerHTML;

  // when inserting a new formula to editor, a non-breakable space
  // is inserted after the formula HTML - they should be replaced
  // with an empty character in markdown
  newContent = newContent.replace(/&nbsp;/g, ' ');

  return newContent;
};
