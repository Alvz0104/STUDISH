"use strict";
  function generateSchedule(event) {
    event.preventDefault();
    if (!$("#scheduleForm").reportValidity()) return;
    const selectedDays = $$('input[name="studyDay"]:checked').map(input => Number(input.value)).sort((a, b) => a - b);
    if (!selectedDays.length) {
      showToast("Choose at least one study day.");
      return;
    }

    const settings = {
      dailyMinutes: Number($("#scheduleDailyMinutes").value),
      studyDays: selectedDays,
      startTime: $("#scheduleStartTime").value,
      breakMinutes: Number($("#scheduleBreakMinutes").value),
      horizonDays: Number($("#scheduleHorizon").value)
    };
    state.settings.schedule = settings;

    const now = new Date();
    const today = todayISO();
    const horizonEnd = new Date(`${today}T00:00:00`);
    horizonEnd.setDate(horizonEnd.getDate() + settings.horizonDays - 1);
    const horizonEndISO = formatISODate(horizonEnd);
    const pendingTasks = state.tasks.filter(task => !task.completed);
    const tasks = pendingTasks.map(task => {
      const deadline = getDeadlineDate(task);
      const deadlineDate = deadline ? formatISODate(deadline) : horizonEndISO;
      return {
        task,
        deadline,
        deadlineDate: deadlineDate < today ? today : deadlineDate,
        remainingMinutes: Math.max(15, Number(task.estimatedMinutes) || 60)
      };
    }).sort((a, b) =>
      a.deadlineDate.localeCompare(b.deadlineDate) ||
      ({ High: 0, Medium: 1, Low: 2 }[a.task.priority] ?? 1) - ({ High: 0, Medium: 1, Low: 2 }[b.task.priority] ?? 1) ||
      (Number(a.task.createdAt) || 0) - (Number(b.task.createdAt) || 0)
    );
    const sessions = [];
    const startParts = settings.startTime.split(":").map(Number);
    const configuredStart = startParts[0] * 60 + startParts[1];
    const sessionMinutes = Math.max(1, Math.ceil(getConfiguredDurationSeconds() / 60));
    const todayStart = Math.max(configuredStart, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5);

    for (let date = new Date(`${today}T00:00:00`); formatISODate(date) <= horizonEndISO; date.setDate(date.getDate() + 1)) {
      if (!settings.studyDays.includes(date.getDay())) continue;
      const dateISO = formatISODate(date);
      const startMinute = dateISO === today ? todayStart : configuredStart;
      let elapsedMinutes = 0;
      let studyMinutes = 0;
      let daySessionCount = 0;

      for (const item of tasks) {
        if (item.deadlineDate < dateISO || item.deadlineDate > horizonEndISO || item.remainingMinutes <= 0) continue;
        const dueMinute = item.deadline && formatISODate(item.deadline) === dateISO && item.deadline > now
          ? item.deadline.getHours() * 60 + item.deadline.getMinutes()
          : 24 * 60;
        while (item.remainingMinutes > 0 && studyMinutes < settings.dailyMinutes) {
          const breakMinutes = daySessionCount ? settings.breakMinutes : 0;
          const availableStudy = settings.dailyMinutes - studyMinutes;
          const availableUntilMidnight = 24 * 60 - startMinute - elapsedMinutes - breakMinutes;
          const availableUntilDeadline = dueMinute - startMinute - elapsedMinutes - breakMinutes;
          const duration = Math.min(sessionMinutes, item.remainingMinutes, availableStudy, availableUntilMidnight, availableUntilDeadline);
          if (duration <= 0) break;

          elapsedMinutes += breakMinutes;
          const sessionStart = startMinute + elapsedMinutes;
          const sessionTime = `${String(Math.floor(sessionStart / 60)).padStart(2, "0")}:${String(sessionStart % 60).padStart(2, "0")}`;
          sessions.push({
            taskId: item.task.id,
            title: item.task.title,
            subject: item.task.subject,
            priority: item.task.priority || "Medium",
            date: dateISO,
            startTime: sessionTime,
            minutes: duration
          });
          elapsedMinutes += duration;
          studyMinutes += duration;
          daySessionCount += 1;
          item.remainingMinutes -= duration;
        }
      }
    }

    const unplanned = tasks.filter(item => item.remainingMinutes > 0).map(item => {
      const outsideWindow = item.deadlineDate > horizonEndISO;
      const remainingMinutes = item.remainingMinutes;
      return {
        taskId: item.task.id,
        title: item.task.title,
        subject: item.task.subject,
        remainingMinutes,
        reason: outsideWindow
          ? `Its deadline is outside this ${settings.horizonDays}-day plan window.`
          : `${remainingMinutes} min could not fit before its deadline.`
      };
    });
    state.schedule = {
      generatedAt: Date.now(),
      settings,
      taskSignature: getScheduleTaskSignature(pendingTasks),
      sessions,
      unplanned
    };
    const saved = saveData();
    renderSchedule();
    if (!saved) return;
    if (!pendingTasks.length) {
      showToast("There are no pending tasks to schedule.");
    } else if (sessions.length) {
      showToast(`Schedule generated with ${sessions.length} focused ${sessions.length === 1 ? "session" : "sessions"}.`);
    } else {
      showToast("No sessions could be planned. Check availability and the tasks needing attention.");
    }
  }
  // Start the selected plan item in the standard focus timer.
  function startScheduledSession(event) {
    const button = event.target.closest("[data-schedule-start]");
    if (!button) return;
    const task = state.tasks.find(item => item.id === button.dataset.taskId && !item.completed);
    if (!task) {
      showToast("This task is no longer pending. Generate a new schedule to update your plan.");
      return;
    }
    setTimerMode("single");
    setSessionLength(button.dataset.scheduleStart, 0);
    switchView("focus");
    startTimer();
  }
  // Refresh every view that depends on task or study-record state.
