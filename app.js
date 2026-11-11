"use strict";
  function initApp() {
    // Remove the previously installed offline worker and its app-shell cache.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        registrations
          .filter(registration => registration.active?.scriptURL.endsWith("/sw.js"))
          .forEach(registration => registration.unregister());
      }).catch(error => console.warn("Could not remove the STUDISH offline worker:", error));
    }
    if ("caches" in window) {
      caches.keys().then(cacheNames => Promise.all(
        cacheNames.filter(cacheName => cacheName.startsWith("studish-app-")).map(cacheName => caches.delete(cacheName))
      )).catch(error => console.warn("Could not remove the STUDISH offline cache:", error));
    }

    $("#todayLabel").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    $("#sessionLength").value = state.settings.sessionLength;
    $("#sessionSeconds").value = state.settings.sessionSeconds;
    $("#pomodoroShortBreak").value = state.settings.pomodoroShortBreak;
    $("#pomodoroLongBreak").value = state.settings.pomodoroLongBreak;
    loadScheduleControls();
    $("#sortOrder").value = "deadline";
    if (currentUser) {
      $("#accountGreeting").textContent = `Hi, ${currentUser.name || currentUser.email.split("@")[0]}`;
      $("#authScreen").classList.add("hidden");
      $("#appShell").classList.remove("hidden");
      applyTheme(state.settings.theme || "light");
    } else {
      $("#authScreen").classList.remove("hidden");
      $("#appShell").classList.add("hidden");
      setAuthMode("login");
    }
    remainingSeconds = getTimerDurationSeconds();
    updateTimerDisplay();
    updateTimerPresets();
    updatePomodoroControls();
    const onBreak = timerMode === "pomodoro" && pomodoroPhase !== "focus";
    setTimerState(onBreak ? "Break ready" : "Ready", onBreak ? "on-break" : "");
    $("#timerSubtext").textContent = onBreak ? "Start your break when you are ready." : "Ready when you are";
    $("#authForm").addEventListener("submit", handleAuthSubmit);
    $("#authModeToggle").addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
    $("#logoutButton").addEventListener("click", signOut);
    // Switch to the view named by the clicked navigation button.
    $$(".nav-link").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
    // Open a new task form from the dashboard shortcut.
    $("#dashboardAddBtn").addEventListener("click", () => openTaskForm());
    // Open a new task form from the task-list page.
    $("#taskAddBtn").addEventListener("click", () => openTaskForm());
    // Offer task creation when the filtered task list is empty.
    $("#emptyAddBtn").addEventListener("click", () => openTaskForm());
    $("#themeToggle").addEventListener("click", () => applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark"));
    $("#clearCompletedBtn").addEventListener("click", clearCompletedTasks);
    $("#scheduleForm").addEventListener("submit", generateSchedule);
    $("#scheduleDayList").addEventListener("click", startScheduledSession);
    $("#reviewerForm").addEventListener("submit", handleCreateReviewer);
    $("#reviewerLibraryList").addEventListener("click", handleReviewerLibraryAction);
    $("#reviewerQuestions").addEventListener("click", toggleReviewerAnswer);
    $("#deleteReviewer").addEventListener("click", () => {
      const reviewer = state.reviewers.find(item => item.id === selectedReviewerId);
      if (reviewer) deleteReviewer(reviewer);
    });
    // Navigate to the task page when the dashboard link is selected.
    $("#seeAllTasks").addEventListener("click", () => switchView("tasks"));
    $("#closeModal").addEventListener("click", closeTaskForm);
    $("#cancelModal").addEventListener("click", closeTaskForm);
    $("#taskForm").addEventListener("submit", handleSaveTask);
    $("#taskList").addEventListener("click", handleTaskAction);
    $("#taskList").addEventListener("change", handleTaskAction);
    $("#upcomingList").addEventListener("change", handleTaskAction);
    // Refresh task results whenever a search or filter value changes.
    ["searchInput", "subjectFilter", "priorityFilter", "statusFilter", "sortOrder"].forEach(id => {
      $(`#${id}`).addEventListener(id === "searchInput" ? "input" : "change", renderTasks);
    });
    $("#startTimer").addEventListener("click", startTimer);
    $("#pauseTimer").addEventListener("click", pauseTimer);
    $("#resetTimer").addEventListener("click", resetTimer);
    $("#singleTimerMode").addEventListener("click", () => setTimerMode("single"));
    $("#pomodoroTimerMode").addEventListener("click", () => setTimerMode("pomodoro"));
    $("#pomodoroShortBreak").addEventListener("change", () =>
      setPomodoroBreakLength($("#pomodoroShortBreak"), "pomodoroShortBreak", 30));
    $("#pomodoroLongBreak").addEventListener("change", () =>
      setPomodoroBreakLength($("#pomodoroLongBreak"), "pomodoroLongBreak", 60));
    // Normalize and save the edited minute value.
    $("#sessionLength").addEventListener("change", () => setSessionLength());
    // Normalize and save the edited second value.
    $("#sessionSeconds").addEventListener("change", () => setSessionLength());
    // Load the clicked preset's minutes and reset the seconds to zero.
    $$(".preset-button").forEach(button => button.addEventListener("click", () => setSessionLength(button.dataset.minutes, 0)));
    // Dismiss the task form when its backdrop is clicked.
    $("#taskModal").addEventListener("click", event => { if (event.target === $("#taskModal")) closeTaskForm(); });
    // Let Escape dismiss the task dialog when it is open.
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("#taskModal").classList.contains("hidden")) closeTaskForm(); });
    window.addEventListener("beforeunload", saveData);
    renderAll();
    // Refresh the time-sensitive views once per minute.
    setInterval(() => {
      renderStats();
      renderUpcoming();
      renderTasks();
    }, 60000);
  }
  document.addEventListener("DOMContentLoaded", initApp);
