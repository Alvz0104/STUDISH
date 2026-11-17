"use strict";
  // Refresh all dashboard, task, schedule, reviewer, and record displays.
  function renderAll() {
    renderStats(); renderUpcoming(); renderTasks(); renderRecords(); renderSchedule(); renderReviewerLibrary(); renderReviewer();
  }
  // Remove finished tasks while leaving pending work untouched.
  function clearCompletedTasks() {
    const previousCount = state.tasks.length;
    const previousTasks = state.tasks;
    state.tasks = state.tasks.filter(task => !task.completed);
    if (state.tasks.length === previousCount) {
      showToast("No completed tasks to clear.");
      return;
    }
    if (!saveData()) {
      state.tasks = previousTasks;
      return;
    }
    renderAll(); showToast("Completed tasks cleared.");
  }
  // Reset and display the task form, filling it when editing an existing task.
  function openTaskForm(task = null) {
    $("#taskForm").reset();
    clearErrors();
    $("#taskId").value = task?.id || "";
    $("#modalTitle").textContent = task ? "Edit task" : "Add task";
    $("#saveTaskBtn").textContent = task ? "Save changes" : "Save task";
    $("#taskTitle").value = task?.title || "";
    $("#taskSubject").value = task?.subject || "";
    $("#taskDeadline").value = task?.deadline || "";
    $("#taskDeadlineTime").value = task?.deadlineTime || "23:59";
    $("#taskEstimate").value = task?.estimatedMinutes || 60;
    $("#taskNotes").value = task?.notes || "";
    const priority = task?.priority || "Medium";
    $(`input[name="priority"][value="${priority}"]`).checked = true;
    $("#taskModal").classList.remove("hidden");
    $("#taskTitle").focus();
  }
  // Hide the task form and clear its values and validation messages.
  function closeTaskForm() {
    $("#taskModal").classList.add("hidden");
    $("#taskForm").reset();
    clearErrors();
  }
  // Clear validation and form-level messages before another submission.
  function clearErrors() {
    // Clear each field-specific error label.
    ["titleError", "subjectError", "deadlineError", "estimateError"].forEach(id => $(`#${id}`).textContent = "");
    $("#formMessage").classList.add("hidden");
  }
  // Validate required task details and ensure the deadline is a real date and time.
  function validateTask(data) {
    let valid = true;
    if (!data.title.trim()) { $("#titleError").textContent = "Task title is required."; valid = false; }
    if (!data.subject.trim()) { $("#subjectError").textContent = "Subject is required."; valid = false; }
    if (!data.deadline || !data.deadlineTime) {
      $("#deadlineError").textContent = "Please select both a due date and time.";
      valid = false;
    } else if (!getDeadlineDate(data)) {
      $("#deadlineError").textContent = "Enter a valid date and time.";
      valid = false;
    }
    if (!Number.isInteger(data.estimatedMinutes) || data.estimatedMinutes < 15 || data.estimatedMinutes > 600 || data.estimatedMinutes % 15 !== 0) {
      $("#estimateError").textContent = "Enter an estimate from 15 to 600 minutes in 15-minute steps.";
      valid = false;
    }
    return valid;
  }
  // Validate and save the task form, preserving completion information on edits.
  function handleSaveTask(event) {
    event.preventDefault();
    clearErrors();
    const id = $("#taskId").value;
    // Find the saved task so edits retain its creation and completion metadata.
    const existing = state.tasks.find(task => String(task.id) === id);
    const data = {
      id: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      title: $("#taskTitle").value.trim(),
      subject: $("#taskSubject").value.trim(),
      deadline: $("#taskDeadline").value,
      deadlineTime: $("#taskDeadlineTime").value,
      estimatedMinutes: Number($("#taskEstimate").value),
      priority: $('input[name="priority"]:checked').value,
      notes: $("#taskNotes").value.trim(),
      completed: existing?.completed || false,
      completedAt: existing?.completedAt || null,
      createdAt: existing?.createdAt || Date.now()
    };
    if (!validateTask(data)) return;
    // Replace the edited item, or append a new task when no matching item exists.
    const previousTasks = state.tasks;
    state.tasks = existing
      ? state.tasks.map(task => String(task.id) === id ? data : task)
      : [...state.tasks, data];
    if (!saveData()) {
      state.tasks = previousTasks;
      renderAll();
      return;
    }
    closeTaskForm(); renderAll();
    showToast(existing ? "Task updated successfully." : "Task added successfully.");
  }
  // Handle task completion toggles, edits, and confirmed deletions.
  function handleTaskAction(event) {
    const row = event.target.closest("[data-task-id]");
    if (!row) return;
    // Resolve the task associated with the clicked task row.
    const task = state.tasks.find(item => String(item.id) === row.dataset.taskId);
    if (!task) return;
    const action = event.target.dataset.action;
    if (action === "toggle") {
      const previousCompleted = task.completed;
      const previousCompletedAt = task.completedAt;
      task.completed = event.target.checked;
      task.completedAt = task.completed ? Date.now() : null;
      if (!saveData()) {
        task.completed = previousCompleted;
        task.completedAt = previousCompletedAt;
        renderAll();
        return;
      }
      renderAll();
      showToast(task.completed ? "Task marked as completed." : "Task moved back to pending.");
    } else if (action === "edit") openTaskForm(task);
    else if (action === "delete") {
      if (window.confirm(`Delete "${task.title}"? This action cannot be undone.`)) {
        // Remove only the task the user confirmed deleting.
        const previousTasks = state.tasks;
        state.tasks = state.tasks.filter(item => item.id !== task.id);
        if (!saveData()) {
          state.tasks = previousTasks;
          renderAll();
          return;
        }
        renderAll(); showToast("Task deleted.");
      }
    }
  }
