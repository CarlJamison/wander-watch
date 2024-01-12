const sql = require('mssql')
const { chromium } = require('playwright');
require('dotenv').config()
const express = require('express');
const app = express();
const http = require('http');
const cors = require('cors');
const cron = require('node-cron');
const { EmailClient } = require("@azure/communication-email");
const bodyParser = require('body-parser');
const fs = require('fs');
const server = http.Server(app);
const port = process.env.PORT || 8888;
const emailClient = new EmailClient(process.env.MAIL_CONNECTION_STRING);
sql.connect(process.env.CONNECTION_STRING)
const email_template = fs.readFileSync('email-template.html').toString();
const trip_template = fs.readFileSync('trip-template.html').toString();

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))
app.use(cors());
app.use(express.json())
app.use(function(req, res, next) {
    if (req.headers.authorization != process.env.PASSWORD_STRING) {
        res.status(403).json({ error: 'FORBIDDEN' });
    }else{
        next();
    }
});
  
app.get('/', async (req, res) => {
    res.send(await getTrips());
});

function processDate(dateString){
    var parsedDate = new Date(dateString);
    parsedDate.setFullYear(new Date().getFullYear());
    parsedDate.setHours(23);

    if(parsedDate < new Date()){
        parsedDate.setFullYear(parsedDate.getFullYear() + 1)
    }

    return parsedDate;
}

app.post('/', async (req, res) => {

    const request = new sql.Request()
    request.input('to', sql.VarChar, req.body.to)
    request.input('from', sql.VarChar, req.body.from)
    request.input('departure', sql.Date, processDate(req.body.departure))
    request.input('return', sql.Date, processDate(req.body.return))
    request.input('price', sql.Decimal, req.body.price)
    await request.query(`insert into Trips
    (toLocation, fromLocation, departureDate, returnDate, tripStatus, price) values
    (@to, @from, @departure, @return, 0, @price)`
    ,(err, result) => {
        res.status(200).send("wow good trip");
        if(err) console.dir(err)
    })

});

app.get('/check', async (req, res) => {
    await checkFlights();
    res.status(200).send("check complete");
});

app.delete("/", async (req, res) => {
    
    const request = new sql.Request()
    request.input('id', sql.Int, req.body.id)

    await request.query(`delete from Trips where id = @id`
    ,(err, result) => {
        res.status(200).send("trip removed");
        if(err) console.dir(err)
    })
});

//TODO Edit

//Daily check
cron.schedule('0 1 * * *', checkFlights);

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});

async function getTrips() {

    try {
        return (await sql.query(`select * from Trips`)).recordset;
    } catch (err) {
        return err
    }
}

async function checkFlights(){
    console.log("Checking . . .")

    const request = new sql.Request()
    request.input('date', sql.Date, new Date())
    await request.query(`delete from Trips where departureDate < @date`
    ,(err, result) => {
        if (err) console.dir(err)
    });

    var trips = await getTrips();

    var results = [];

    await Promise.all(trips.map(async trip => {
        var flights = await getFlights(trip);

        results.push(
            ...flights.filter(t => parseFloat(t.price.replace("$", "").replace(",", "")) / 7 < trip.price));
    }));


    if(results.length){
        console.log(`Checking complete, ${results.length} potential flights found.  Sending email . . .`);

        var emailString = results.reduce(
            (a, r) => a += trip_template
                .replace("{{from}}", r.from)
                .replace("{{to}}", r.to)
                .replace("{{departure}}", new Date(r.departureDate).toLocaleDateString('en-US'))
                .replace("{{return}}", new Date(r.returnDate).toLocaleDateString('en-US'))
                .replace("{{price}}", r.price)
                .replace("{{description}}", r.description),
            "",
        );

        const emailMessage = {
            senderAddress: "DoNotReply@566b52af-1f5a-4736-8532-0f99329e9235.azurecomm.net",
            content: {
                subject: "Wander Watch",
                html: email_template.replace("{{flights}}", emailString),
            },
            recipients: {
                to: [{ address: "karjaxthevaliant@gmail.com" }],
            },
        };
    
        const poller = await emailClient.beginSend(emailMessage);
        await poller.pollUntilDone();

        console.log(`Email sent`);

    }else{
        console.log("No results found.")
    }

}

async function getFlights(options){
	var flightInfoList = [];

	const browser = await chromium.launch();
	const page = await browser.newPage();
	try {
		await page.goto('https://www.google.com/travel/flights');
		await page.getByLabel('1 passenger, change number of').click({delay : 100});
		await page.getByLabel('Add adult').click({
		  clickCount: 6,
		  delay : 100
		});
		await page.getByRole('button', { name: 'Done' }).click({delay : 100});
		await page.getByLabel('Where from? Minneapolis').click({delay : 100});
		await page.getByRole('combobox', { name: 'Where else?' }).fill(options.fromLocation);
		await page.getByRole('combobox', { name: 'Where else?' }).press('Enter', {delay : 100});
		await page.keyboard.press('Tab', {delay : 100});
		await page.keyboard.type(options.toLocation, {delay : 100})
		await page.getByRole('combobox', { name: 'Where else?' }).press('Enter', {delay : 100});
		await page.keyboard.press('Tab', {delay : 100});
		await page.getByRole('textbox', { name: 'Departure' }).fill(options.departureDate.toString());
		await page.keyboard.press('Tab', {delay : 100});
		await page.getByRole('textbox', { name: 'Return' }).fill(options.returnDate.toString());
		await page.keyboard.press('Tab', {delay : 100});
		await page.keyboard.press('Enter', {delay : 1000});
		await page.waitForSelector('.pIav2d');
		
		var flightInfoList = await page.$$eval('.pIav2d', items =>
			items.map(item => ({
				description:item.querySelector('.JMc5Xc').ariaLabel.trim().replace(" Select flight", ""), 
				airline: item.querySelector('.sSHqwe').textContent.trim(),
				travelTime: item.querySelector('.gvkrdb').textContent.trim(),
				price: item.querySelector('.YMlIz.FpEdX').children[0].textContent.trim()
			}))
		);
	} catch (error) {
		console.log(error)
	} finally {
		await browser.close();
	}

	return flightInfoList.map(f => ({
        ...f,
        from: options.fromLocation,
        to: options.toLocation,
        departureDate: options.departureDate,
        returnDate: options.returnDate,
    }));
};