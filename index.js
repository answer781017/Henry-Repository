const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const ics = require('ics');
const { formatInTimeZone } = require('date-fns-tz');

const app = express();
app.use(cors());
app.use(express.json());

// 透過環境變數讀取資料庫連線字串，部署時更安全
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 1. 新增或更新課表與實際訓練數據 (POST)
app.post('/api/workouts', async (req, res) => {
  const { client_name, scheduled_date, start_time, end_time, focus_area, coach_notes, exercises } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertWorkoutQuery = `
      INSERT INTO Workouts (client_name, scheduled_date, start_time, end_time, focus_area, coach_notes)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id;
    `;
    const workoutRes = await client.query(insertWorkoutQuery, [client_name, scheduled_date, start_time, end_time, focus_area, coach_notes]);
    const newWorkoutId = workoutRes.rows[0].id;

    if (exercises && exercises.length > 0) {
      const insertExQuery = `INSERT INTO Workout_Exercises (workout_id, exercise_id, order_index, group_code, sets_data) VALUES ($1, $2, $3, $4, $5);`;
      for (const ex of exercises) {
        await client.query(insertExQuery, [newWorkoutId, ex.exercise_id, ex.order_index, ex.group_code, JSON.stringify(ex.sets_data)]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, workout_id: newWorkoutId });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// 2. 讀取特定學生日期的課表與歷史表現 (GET)
app.get('/api/workouts', async (req, res) => {
  const { client_name, date } = req.query;
  try {
    const query = `
      SELECT w.id AS workout_id, w.client_name, w.scheduled_date, w.focus_area, w.coach_notes,
             we.id AS workout_exercise_id, we.order_index, we.group_code, we.sets_data,
             e.id AS exercise_id, e.name AS exercise_name
      FROM Workouts w
      JOIN Workout_Exercises we ON w.id = we.workout_id
      JOIN Exercises e ON we.exercise_id = e.id
      WHERE w.client_name = $1 AND w.scheduled_date = $2
      ORDER BY we.order_index ASC;
    `;
    const result = await pool.query(query, [client_name, date]);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Apple Calendar 訂閱 (GET)
app.get('/api/calendar/feed.ics', async (req, res) => {
  const token = req.query.token;
  if (token !== process.env.CALENDAR_TOKEN) return res.status(403).send('Unauthorized');
  
  try {
    const result = await pool.query(`SELECT * FROM Workouts WHERE status = 'Scheduled'`);
    const events = result.rows.map(workout => {
      const startDateTimeStr = `${workout.scheduled_date.toISOString().split('T')[0]}T${workout.start_time}`;
      const endDateTimeStr = `${workout.scheduled_date.toISOString().split('T')[0]}T${workout.end_time}`;
      const startArr = formatInTimeZone(startDateTimeStr, 'Asia/Taipei', 'yyyy-M-d-H-m').split('-').map(Number);
      const endArr = formatInTimeZone(endDateTimeStr, 'Asia/Taipei', 'yyyy-M-d-H-m').split('-').map(Number);
      
      return {
        title: `🏋️ [課表] ${workout.client_name}`,
        description: `重點: ${workout.focus_area || '無'}`,
        start: startArr,
        end: endArr,
        status: 'CONFIRMED'
      };
    });
    
    if (events.length === 0) {
        res.set('Content-Type', 'text/calendar; charset=utf-8');
        return res.send("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR");
    }
    
    ics.createEvents(events, (error, value) => {
      if (error) return res.status(500).send('Error generating calendar');
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.send(value);
    });
  } catch (error) {
    res.status(500).send('Server Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
