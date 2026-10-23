/** Only owner-authored, credential-free diagnostics may cross a startup boundary.
 * Never construct this class from transport text, paths or other untrusted input.
 */
export class SafeDiagnosticError extends Error {
  override readonly name = 'SafeDiagnosticError';
}
