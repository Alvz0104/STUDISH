"use strict";
  function createReviewerContent(source) {
    const sentences = source
      .split(/(?<=[.!?])\s+|\n+/)
      .map(sentence => sentence.trim().replace(/\s+/g, " "))
      .filter(sentence => sentence.length >= 20);
    const uniqueSentences = [...new Set(sentences)].slice(0, 10);
    if (!uniqueSentences.length) return null;

    const stopWords = new Set([
      "about", "after", "again", "being", "between", "could", "every", "first",
      "from", "have", "other", "their", "there", "these", "those", "which",
      "while", "where", "would", "should", "because", "through", "during"
    ]);
    const questions = uniqueSentences.slice(0, 5).map(sentence => {
      const keywords = sentence.match(/\b[A-Za-z][A-Za-z-]{4,}\b/g) || [];
      const answer = keywords.find(word => !stopWords.has(word.toLowerCase())) || keywords[0];
      if (!answer) return { prompt: `Explain this idea in your own words: ${sentence}`, answer: sentence };
      const escapedAnswer = answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return {
        prompt: `Fill in the missing key term: ${sentence.replace(new RegExp(`\\b${escapedAnswer}\\b`, "i"), "_____")}`,
        answer
      };
    });
    return {
      keyPoints: uniqueSentences.slice(0, 8),
      questions
    };
  }
  // List saved reviewers newest-first and mark the selected one.
  function renderReviewerLibrary() {
    const reviewers = state.reviewers || [];
    $("#reviewerCount").textContent = `${reviewers.length} ${reviewers.length === 1 ? "reviewer" : "reviewers"}`;
    $("#emptyReviewers").classList.toggle("hidden", reviewers.length > 0);
    $("#reviewerLibraryList").innerHTML = [...reviewers]
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .map(reviewer => `<article class="reviewer-library-item${reviewer.id === selectedReviewerId ? " selected" : ""}" data-reviewer-id="${escapeHTML(reviewer.id)}">
        <button class="reviewer-open-button" type="button" data-reviewer-action="open">
          <strong>${escapeHTML(reviewer.title)}</strong>
          <span>${escapeHTML(reviewer.subject)} · ${reviewer.keyPoints.length} key points</span>
        </button>
        <button class="reviewer-delete-button" type="button" data-reviewer-action="delete" aria-label="Delete ${escapeHTML(reviewer.title)}">Delete</button>
      </article>`).join("");
  }
  // Show the selected reviewer's key points and hidden answers.
  function renderReviewer() {
    const reviewer = state.reviewers.find(item => item.id === selectedReviewerId);
    $("#reviewerResults").classList.toggle("hidden", !reviewer);
    $("#emptyReviewerResult").classList.toggle("hidden", Boolean(reviewer));
    $("#deleteReviewer").classList.toggle("hidden", !reviewer);
    if (!reviewer) {
      $("#reviewerResultTitle").textContent = "Your reviewer";
      $("#reviewerResultMeta").textContent = "Create a reviewer or choose one from your library.";
      $("#reviewerKeyPoints").innerHTML = "";
      $("#reviewerQuestions").innerHTML = "";
      return;
    }

    $("#reviewerResultTitle").textContent = reviewer.title;
    $("#reviewerResultMeta").textContent = `${reviewer.subject} · Created ${new Date(reviewer.createdAt).toLocaleDateString()}`;
    $("#reviewerKeyPoints").innerHTML = reviewer.keyPoints.map(point => `<li>${escapeHTML(point)}</li>`).join("");
    $("#reviewerQuestions").innerHTML = reviewer.questions.map((question, index) =>
      `<article class="reviewer-question">
        <p>${index + 1}. ${escapeHTML(question.prompt)}</p>
        <button type="button" data-reviewer-question="${index}" aria-expanded="false">Show answer</button>
        <span class="reviewer-answer hidden">${escapeHTML(question.answer)}</span>
      </article>`
    ).join("");
  }
  // Validate note input, generate a reviewer, and persist it to the profile.
  function handleCreateReviewer(event) {
    event.preventDefault();
    if (!$("#reviewerForm").reportValidity()) return;

    const source = $("#reviewerSource").value.trim();
    const content = createReviewerContent(source);
    if (!content) {
      showToast("Add a few complete sentences so key points and questions can be created.");
      return;
    }

    const reviewer = {
      id: window.crypto.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: $("#reviewerTitle").value.trim(),
      subject: $("#reviewerSubject").value.trim(),
      source,
      ...content,
      createdAt: Date.now()
    };
    state.reviewers.push(reviewer);
    if (!saveData()) {
      state.reviewers = state.reviewers.filter(item => item.id !== reviewer.id);
      return;
    }
    selectedReviewerId = reviewer.id;
    renderReviewerLibrary();
    renderReviewer();
    $("#reviewerForm").reset();
    showToast("Your personal reviewer is ready and saved.");
  }
  // Open a saved reviewer or pass its deletion to the confirmation handler.
  function handleReviewerLibraryAction(event) {
    const button = event.target.closest("[data-reviewer-action]");
    const row = event.target.closest("[data-reviewer-id]");
    if (!button || !row) return;
    const reviewer = state.reviewers.find(item => item.id === row.dataset.reviewerId);
    if (!reviewer) return;

    if (button.dataset.reviewerAction === "open") {
      selectedReviewerId = reviewer.id;
      renderReviewerLibrary();
      renderReviewer();
      return;
    }
    if (button.dataset.reviewerAction === "delete") deleteReviewer(reviewer);
  }
  // Delete a reviewer only after confirmation and successful persistence.
  function deleteReviewer(reviewer) {
    if (!window.confirm(`Delete "${reviewer.title}"? This action cannot be undone.`)) return;
    const previousReviewers = state.reviewers;
    state.reviewers = state.reviewers.filter(item => item.id !== reviewer.id);
    if (!saveData()) {
      state.reviewers = previousReviewers;
      return;
    }
    if (selectedReviewerId === reviewer.id) selectedReviewerId = null;
    renderReviewerLibrary();
    renderReviewer();
    showToast("Reviewer deleted.");
  }
  // Reveal or hide a practice answer and update its accessible state.
  function toggleReviewerAnswer(event) {
    const button = event.target.closest("[data-reviewer-question]");
    if (!button) return;
    const answer = button.nextElementSibling;
    const expanded = answer.classList.toggle("hidden") === false;
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = expanded ? "Hide answer" : "Show answer";
  }
  // Allocate pending study time across available days before task deadlines.
