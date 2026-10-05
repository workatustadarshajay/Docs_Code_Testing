(function copyPageText() {
  // 1. Get all visible text from the body
  const text = document.body.innerText;

  // 2. Create a temporary textarea in DOM to bypass focus errors
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  // 3. Select and copy
  textarea.focus();
  textarea.select();

  try {
    const successful = document.execCommand('copy');
    if (successful) {
      showToast('✅ Copied all text to clipboard!');
    } else {
      alert('Copy failed. Try selecting text manually.');
    }
  } catch (err) {
    console.error('Unable to copy:', err);
  }

  // 4. Clean up DOM element
  document.body.removeChild(textarea);

  // On-screen notification
  function showToast(message) {
    const toast = document.createElement('div');
    toast.innerText = message;
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.backgroundColor = '#00a0a9';
    toast.style.color = '#ffffff';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '6px';
    toast.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.2)';
    toast.style.zIndex = '999999';
    toast.style.fontFamily = 'sans-serif';
    toast.style.fontSize = '14px';

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }
})();
