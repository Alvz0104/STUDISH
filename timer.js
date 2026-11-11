"use strict";
  function updateTimerDisplay() {
    const minutes = Math.floor(remainingSeconds / 60).toString().padStart(2, "0");
    const seconds = (remainingSeconds % 60).toString().padStart(2, "0");
    $("#timerDisplay").textContent = `${minutes}:${seconds}`;
    const totalSeconds = Math.max(1, getTimerDurationSeconds());
    const progress = Math.min(100, Math.max(0, Math.round((totalSeconds - remainingSeconds) / totalSeconds * 100)));
    $("#timerRing").style.setProperty("--timer-progress", `${progress}%`);
    $("#timerRing").setAttribute("aria-valuenow", progress);
    $("#timerRing").setAttribute("aria-valuetext", `${progress}% complete`);
  }
  // Synchronize the timer's text label and visual state classes.
  function setTimerState(label, className = "") {
    $("#timerState").textContent = label;
    $("#timerRing").classList.remove("running", "paused", "finished", "on-break");
    if (className) $("#timerRing").classList.add(...className.split(" "));
  }
  // Mark the matching preset and disable preset changes during a running session.
  function updateTimerPresets() {
    $$(".preset-button").forEach(button => {
      // A preset is selected only when its minutes match and seconds are zero.
      const selected = Number(button.dataset.minutes) === Number($("#sessionLength").value) &&
        Number($("#sessionSeconds").value) === 0;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = timerRunning || (timerMode === "pomodoro" && pomodoroPhase !== "focus");
    });
  }
  // Select the current focus or break duration in seconds.
  function getTimerDurationSeconds() {
    if (timerMode !== "pomodoro" || pomodoroPhase === "focus") return getConfiguredDurationSeconds();
    const setting = pomodoroPhase === "shortBreak" ? "pomodoroShortBreak" : "pomodoroLongBreak";
    return Number(state.settings[setting]) * 60;
  }
  // Keep mode buttons, duration inputs, and labels in sync with the phase.
  function updatePomodoroControls() {
    const pomodoro = timerMode === "pomodoro";
    $("#singleTimerMode").classList.toggle("active", !pomodoro);
    $("#singleTimerMode").setAttribute("aria-pressed", String(!pomodoro));
    $("#pomodoroTimerMode").classList.toggle("active", pomodoro);
    $("#pomodoroTimerMode").setAttribute("aria-pressed", String(pomodoro));
    $("#singleTimerMode").disabled = timerRunning;
    $("#pomodoroTimerMode").disabled = timerRunning;
    $("#pomodoroOptions").classList.toggle("hidden", !pomodoro);
    $("#pomodoroShortBreak").disabled = timerRunning;
    $("#pomodoroLongBreak").disabled = timerRunning;
    const editingFocus = !pomodoro || pomodoroPhase === "focus";
    $("#sessionLength").disabled = timerRunning || !editingFocus;
    $("#sessionSeconds").disabled = timerRunning || !editingFocus;
    $("#sessionControlLabel").textContent = pomodoro ? "Focus length" : "Session length";
    $("#timerCaption").textContent = pomodoro
      ? pomodoroPhase === "focus" ? "FOCUS ROUND" : pomodoroPhase === "shortBreak" ? "SHORT BREAK" : "LONG BREAK"
      : "TIME TO FOCUS";
    $("#timerRing").setAttribute("aria-label", pomodoro
      ? pomodoroPhase === "focus" ? "Pomodoro focus progress" : "Pomodoro break progress"
      : "Study session progress");
    $("#timerHint").textContent = pomodoro
      ? "Complete four focus rounds to earn a long break."
      : "Tip: Choose one task to focus on until the timer ends.";
    $("#pomodoroCycle").textContent = pomodoroPhase === "longBreak" && pomodoroCount === 4
      ? "4 of 4 focus rounds complete"
      : `${pomodoroCount} of 4 focus rounds complete`;
    $("#startTimer").textContent = pomodoro
      ? pomodoroPhase === "focus" ? "Start focus" : "Start break"
      : "Start";
    updateTimerPresets();
  }
  // Switch timer modes and start a fresh Pomodoro cycle when selected.
  function setTimerMode(mode) {
    if (timerRunning || !["single", "pomodoro"].includes(mode) || timerMode === mode) return;
    timerMode = mode;
    state.settings.timerMode = mode;
    if (mode === "pomodoro") {
      pomodoroPhase = "focus";
      pomodoroCount = 0;
      state.settings.pomodoroPhase = pomodoroPhase;
      state.settings.pomodoroCount = pomodoroCount;
    }
    resetTimer();
    updatePomodoroControls();
    saveData();
  }
  // Validate and save break lengths, refreshing the active break if needed.
  function setPomodoroBreakLength(input, setting, maximum) {
    const minutes = Number(input.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > maximum) {
      input.value = state.settings[setting];
      showToast(`Enter a break length from 1 to ${maximum} minutes.`);
      return;
    }
    state.settings[setting] = minutes;
    if (timerMode === "pomodoro" && pomodoroPhase === (setting === "pomodoroShortBreak" ? "shortBreak" : "longBreak")) {
      resetTimer();
    }
    saveData();
  }
  // Create or resume the audio context in response to a user-initiated timer start.
  function prepareCompletionAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      completionAudioUnavailable = true;
      return;
    }
    try {
      if (!completionAudioContext) completionAudioContext = new AudioContextClass();
      if (completionAudioContext.state === "suspended") {
        // Log audio permission or browser failures without interrupting the timer.
        completionAudioContext.resume().catch(error => console.warn("Could not enable STUDISH timer audio:", error));
      }
    } catch (error) {
      completionAudioUnavailable = true;
      console.warn("Could not prepare STUDISH timer audio:", error);
    }
  }
  // Play a short completion melody when the focus timer reaches zero.
  function playCompletionTone(completionLabel = "Focus session complete") {
    if (completionAudioUnavailable || !completionAudioContext || completionAudioContext.state === "closed") {
      showToast(`${completionLabel}. Timer sound is unavailable in this browser.`);
      return;
    }
    // Schedule each note in the completion melody using the active audio context.
    const play = () => {
      // Use two repeated three-note phrases for the completion sound.
      const frequencies = [880, 1175, 880, 988, 1319, 988];
      const startAt = completionAudioContext.currentTime + 0.05;
      // Create one fading oscillator tone for each melody frequency.
      frequencies.forEach((frequency, index) => {
        // Stagger the tones and add a brief pause between the phrases.
        const start = startAt + index * 0.42 + (index >= 3 ? 0.18 : 0);
        const oscillator = completionAudioContext.createOscillator();
        const envelope = completionAudioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        envelope.gain.setValueAtTime(0.0001, start);
        envelope.gain.exponentialRampToValueAtTime(0.14, start + 0.025);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
        oscillator.connect(envelope);
        envelope.connect(completionAudioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.36);
      });
    };
    try {
      if (completionAudioContext.state === "suspended") {
        completionAudioContext.resume().then(play).catch(error => {
          // Explain why no sound played while keeping the completed session saved.
          console.warn("Could not play STUDISH timer sound:", error);
          showToast(`${completionLabel}, but the timer sound could not play.`);
        });
      } else {
        play();
      }
    } catch (error) {
      console.warn("Could not play STUDISH timer sound:", error);
      showToast(`${completionLabel}, but the timer sound could not play.`);
    }
  }
  // Start counting down and lock duration controls until the session pauses or ends.
  function startTimer() {
    if (timerRunning) return;
    if (remainingSeconds <= 0) {
      remainingSeconds = getTimerDurationSeconds();
      updateTimerDisplay();
    }
    prepareCompletionAudio();
    timerRunning = true;
    $("#startTimer").disabled = true;
    $("#pauseTimer").disabled = false;
    updatePomodoroControls();
    const onBreak = timerMode === "pomodoro" && pomodoroPhase !== "focus";
    setTimerState(onBreak ? "On break" : "Focusing", onBreak ? "running on-break" : "running");
    $("#timerSubtext").textContent = timerMode === "pomodoro" && pomodoroPhase !== "focus"
      ? "Step away and recharge."
      : "One thing at a time";
    timerInterval = setInterval(tick, 1000);
  }
  // Stop the countdown while keeping the remaining time available to resume.
  function pauseTimer() {
    if (!timerRunning) return;
    clearInterval(timerInterval); timerInterval = null; timerRunning = false;
    $("#startTimer").disabled = false; $("#pauseTimer").disabled = true;
    updatePomodoroControls();
    setTimerState("Paused", timerMode === "pomodoro" && pomodoroPhase !== "focus" ? "paused on-break" : "paused");
    $("#timerSubtext").textContent = "Take a breath. Resume when ready.";
  }
  // Stop the countdown and restore the currently configured duration.
  function resetTimer() {
    clearInterval(timerInterval); timerInterval = null; timerRunning = false;
    remainingSeconds = getTimerDurationSeconds() || 1;
    $("#startTimer").disabled = false; $("#pauseTimer").disabled = true;
    updatePomodoroControls();
    updateTimerDisplay();
    const onBreak = timerMode === "pomodoro" && pomodoroPhase !== "focus";
    setTimerState(onBreak ? "Break ready" : "Ready", onBreak ? "on-break" : "");
    $("#timerSubtext").textContent = timerMode === "pomodoro" && pomodoroPhase !== "focus"
      ? "Start your break when you are ready."
      : "Ready to focus";
  }
  // Decrease the timer once per second and finish the session at zero.
  function tick() {
    remainingSeconds = Math.max(0, remainingSeconds - 1);
    updateTimerDisplay();
    if (remainingSeconds === 0) finishTimer();
  }
  // Save a completed focus session, refresh records, and play its completion tone.
  function finishTimer() {
    clearInterval(timerInterval); timerInterval = null; timerRunning = false;
    const finishedPhase = pomodoroPhase;
    const durationSeconds = getTimerDurationSeconds();
    let message;
    if (timerMode !== "pomodoro" || finishedPhase === "focus") {
      const minutes = Math.floor(durationSeconds / 60);
      state.records.push({ id: String(Date.now()), minutes, durationSeconds, date: todayISO(), completedAt: Date.now() });
      if (timerMode === "pomodoro") {
        pomodoroCount = Math.min(4, pomodoroCount + 1);
        pomodoroPhase = pomodoroCount === 4 ? "longBreak" : "shortBreak";
        state.settings.pomodoroCount = pomodoroCount;
        state.settings.pomodoroPhase = pomodoroPhase;
        message = pomodoroPhase === "longBreak"
          ? "Pomodoro complete. Your long break is ready."
          : "Focus round complete. Your short break is ready.";
        $("#timerSubtext").textContent = pomodoroPhase === "longBreak"
          ? "Four rounds done. Take a longer break."
          : "Nice work. Take a short break.";
      } else {
        message = `Focus session completed — ${formatStudyTime(durationSeconds)} recorded.`;
        $("#timerSubtext").textContent = "Great work!";
      }
    } else {
      pomodoroPhase = "focus";
      if (finishedPhase === "longBreak") pomodoroCount = 0;
      state.settings.pomodoroCount = pomodoroCount;
      state.settings.pomodoroPhase = pomodoroPhase;
      message = finishedPhase === "longBreak"
        ? "Long break complete. Ready for a fresh Pomodoro cycle."
        : "Break complete. Ready for your next focus round.";
      $("#timerSubtext").textContent = "Recharge complete. Focus when you are ready.";
    }

    remainingSeconds = getTimerDurationSeconds();
    const saved = saveData();
    renderRecords();
    $("#startTimer").disabled = false; $("#pauseTimer").disabled = true;
    updatePomodoroControls();
    updateTimerDisplay();
    const onBreak = timerMode === "pomodoro" && pomodoroPhase !== "focus";
    setTimerState(timerMode === "pomodoro"
      ? onBreak ? "Break ready" : "Focus ready"
      : "Completed", onBreak ? "finished on-break" : "finished");
    if (saved) showToast(message);
    playCompletionTone(timerMode === "pomodoro" && finishedPhase !== "focus" ? "Break complete" : "Focus session complete");
  }
  // Clamp the selected session duration, save it, and restart the timer with that value.
  function setSessionLength(minutesValue = $("#sessionLength").value, secondsValue = $("#sessionSeconds").value) {
    const minutesInput = $("#sessionLength");
    const secondsInput = $("#sessionSeconds");
    let minutes = Number(minutesValue);
    let seconds = Number(secondsValue);
    if (!Number.isFinite(minutes)) minutes = 25;
    if (!Number.isFinite(seconds)) seconds = 0;
    minutes = Math.min(180, Math.max(0, Math.round(minutes)));
    seconds = Math.min(59, Math.max(0, Math.round(seconds)));
    if (minutes === 0 && seconds === 0) seconds = 1;
    minutesInput.value = minutes;
    secondsInput.value = seconds;
    state.settings.sessionLength = minutes;
    state.settings.sessionSeconds = seconds;
    saveData(); resetTimer();
    updatePomodoroControls();
  }
  // Connect page controls to their handlers and render the initial application state.
